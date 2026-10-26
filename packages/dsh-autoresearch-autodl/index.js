/**
 * dsh-autoresearch-autodl —— AutoDL 算力接入（开放 API + 自动化调度）。
 *
 * ## 这台机器和「内场」是两件事，别混
 *
 * - **内场**（Harbor / 正式评分）：只接受 H20 / L20，由 QA15 与红线约束。
 * - **AutoDL**（专家自己的探索、预跑、调参）：H800/4090/PRO6000 等都能租。
 *
 * 所以本包**不参与**内场门禁。它解决的是更前面的问题：专家要跑实验、
 * 要预跑拿 B/R/U、要验证依赖能不能装 —— 这些过去靠手工在网页上点，
 * 现在走 API。
 *
 * ## 密钥
 *
 * token 从 `.dsh-home/.autodl.json`（已被 gitignore）或环境变量
 * `AUTODL_TOKEN` 读，**不写进源码、不回显、不进 git**。
 *
 * @module dsh-autoresearch-autodl
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import {
  readBalance, listInstances, listImages, readSnapshot, readInstanceStatus,
  createInstance, powerOn, powerOff, releaseInstance, saveImage,
  GPU_SPECS, DATA_CENTERS, CREATE_LIMITS, ENDPOINTS, yuan, AutoDLError,
} from './lib/client.js'
import {
  provisionInstance, reconcileLeases, reapExpiredLeases, instanceCostReport,
  readLeases, expiredLeases, estimateCost, DEFAULT_LEASE_FILE,
} from './lib/automation.js'
import {
  normalizeAutodlConfig, resolveAutodlToken, leaseFilePath,
} from './lib/config.js'

export const name = 'autoresearch-autodl'

export const inject = ['tools']

const DEFAULT_CONFIG = Object.freeze({
  /** 租约账本；相对路径以 cwd 为基准。建议放在任务根之外，避免进 git。 */
  leaseFile: DEFAULT_LEASE_FILE,
  /** 默认 GPU 规格。 */
  defaultGpuSpec: 'v-48g',
  /** 默认 CUDA 版本下限（113 = 11.3）。 */
  defaultCudaVersion: 113,
  /** 预算护栏：单次创建预估上限（元）。 */
  maxTotalYuan: 20,
  /** 单价（元/小时）。文档未给计费单位，必须由使用者按自己的账单口径填。 */
  pricePerHourYuan: null,
  /** 自动回收默认模式：stop 保留磁盘，release 释放（不可恢复）。 */
  reapMode: 'stop',
  /** 单次 API 超时。 */
  timeoutMs: 30_000,
})

const leaseFileOf = (config) => leaseFilePath(config)

const callOptions = (config, token) => ({
  token, timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
})


/** 统一的 JSON 输出形态：dsh-tools 强制要求 output.render，缺它会直接抛错。 */
const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

export function apply(ctx, config = {}) {
  const cfg = normalizeAutodlConfig(config)
  const withToken = async () => {
    const token = await resolveAutodlToken(cfg)
    return callOptions(cfg, token)
  }

  // ── 只读：账户与资源 ────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_account',
    description: '查 AutoDL 账户余额（元）与累计消费。只读，不产生费用。',
    parameters: {},
    async execute() {
      const options = await withToken()
      const [balance, { instances, page }] = await Promise.all([
        readBalance(options),
        listInstances({ ...options, pageSize: 100 }),
      ])
      const running = instances.filter((i) => i.status === 'running')
      return {
        balance,
        instances: { total: page.total, running: running.length, list: instances },
        hint: running.length > 0
          ? `当前有 ${running.length} 台运行中，按量计费持续产生费用`
          : '当前无运行中实例，不产生算力费用',
      }
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_instances',
    description: '列 AutoDL 实例（含状态、GPU 规格、到期时间）。只读。',
    parameters: {
      page_index: { type: 'number', description: '页码，默认 1' },
      page_size: { type: 'number', description: '每页条数，默认 20' },
    },
    async execute(args) {
      const options = await withToken()
      return listInstances({ ...options, pageIndex: args?.page_index, pageSize: args?.page_size })
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_specs',
    description: '列 AutoDL 可租 GPU 规格、数据中心代码与创建参数约束。只读，无需 token。',
    parameters: {},
    async execute() {
      return {
        gpuSpecs: GPU_SPECS,
        dataCenters: DATA_CENTERS,
        limits: CREATE_LIMITS,
        note: '这些型号只用于专家探索/预跑；内场正式评分仍只接受 H20/L20（QA15 约束）。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_images',
    description: '列 AutoDL 自定义镜像。只读。',
    parameters: {
      page_index: { type: 'number', description: '页码，默认 1' },
      page_size: { type: 'number', description: '每页条数，默认 20' },
    },
    async execute(args) {
      const options = await withToken()
      return listImages({ ...options, pageIndex: args?.page_index, pageSize: args?.page_size })
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_snapshot',
    description: '查单个实例详情：SSH 连接信息、GPU、价格与资源使用。只读。',
    parameters: {
      instance_uuid: { type: 'string', description: '实例 uuid', required: true },
    },
    async execute(args) {
      const uuid = args?.instance_uuid
      if (typeof uuid !== 'string' || uuid === '') {
        throw new AutoDLError('必须提供 instance_uuid')
      }
      const options = await withToken()
      const [snapshot, status] = await Promise.all([
        readSnapshot(uuid, options),
        readInstanceStatus(uuid, options),
      ])
      // SSH 密码是敏感信息：默认不回显，只说明「已提供」。
      const { rootPassword, ...rest } = snapshot
      return {
        status,
        ...rest,
        sshPasswordProvided: typeof rootPassword === 'string' && rootPassword !== '',
        sshHint: rest.sshCommand
          ? `可直接交给 autoresearch_remote_targets 作为 SSH 目标；密码需从 AutoDL 控制台复制`
          : '尚未分配 SSH（实例未运行或还在初始化）',
      }
    },
  }))

  // ── 成本与租约 ─────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_leases',
    description: '看租约账本：本平台创建过哪些实例、是否超期、预估花费。只读。',
    parameters: {
      include_expired: { type: 'boolean', description: '是否列出已超期租约，默认 true' },
    },
    async execute(args) {
      const ledger = await readLeases(leaseFileOf(cfg))
      const expired = expiredLeases(ledger)
      const active = ledger.leases.filter((l) => l.status === 'running' || l.status === 'stopped')
      return {
        leaseFile: leaseFileOf(cfg),
        active,
        expired: args?.include_expired === false ? undefined : expired,
        totals: {
          all: ledger.leases.length,
          active: active.length,
          expired: expired.length,
          estimatedYuan: Math.round(ledger.leases
            .reduce((sum, l) => sum + (Number(l.estimatedYuan) || 0), 0) * 100) / 100,
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_estimate',
    description: '在创建前估算费用（元）。不调云端、不花钱，纯本地计算。',
    parameters: {
      hours: { type: 'number', description: '计划运行小时数', required: true },
      price_per_hour_yuan: { type: 'number', description: '单价（元/小时）；缺省用配置值' },
      max_total_yuan: { type: 'number', description: '单次上限；缺省用配置值' },
    },
    async execute(args) {
      return estimateCost({
        pricePerHourYuan: args?.price_per_hour_yuan ?? cfg.pricePerHourYuan,
        hours: args?.hours,
        budget: { maxTotalYuan: args?.max_total_yuan ?? cfg.maxTotalYuan },
      })
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_reconcile',
    description: '核对租约账本与云端实例，找出漂移（云端消失/未纳管/创建中断）。会写账本，不动云端。',
    parameters: {},
    async execute() {
      const options = await withToken()
      const { ledger, adrift } = await reconcileLeases({
        leaseFile: leaseFileOf(cfg), token: options.token,
      })
      return {
        ...adrift,
        active: ledger.leases.filter((l) => l.status === 'running' || l.status === 'stopped'),
        note: adrift.unmanaged.length > 0
          ? `${adrift.unmanaged.length} 台实例不在本平台账本内（可能是在控制台手动创建），不自动接管`
          : '账本与云端一致',
      }
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_reap',
    description: '回收超期实例（默认只关机）。支持 dry_run 预演，不产生费用变更。',
    parameters: {
      mode: { type: 'string', enum: ['stop', 'release'], description: 'stop=关机保盘（默认），release=关机后释放（数据不可恢复）' },
      dry_run: { type: 'boolean', description: '只预演不执行' },
    },
    async execute(args) {
      const options = await withToken()
      return reapExpiredLeases({
        leaseFile: leaseFileOf(cfg),
        token: options.token,
        mode: args?.mode ?? cfg.reapMode,
        dryRun: args?.dry_run === true,
      })
    },
  }))

  // ── 写操作：创建 / 开关机 / 释放 / 镜像 ─────────────────────────────────

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_create',
    description: '创建 AutoDL 实例（按量计费，先过预算护栏）。会自动登记租约以便回收。',
    parameters: {
      gpu_spec_uuid: { type: 'string', description: 'GPU 规格 id，见 autoresearch_autodl_specs' },
      image_uuid: { type: 'string', description: '镜像 uuid（自定义镜像或官网公共镜像）', required: true },
      req_gpu_amount: { type: 'number', description: 'GPU 数量 1–4，默认 1' },
      expand_system_disk_by_gb: { type: 'number', description: '系统盘扩容 0–500 GB，默认 0' },
      cuda_v_from: { type: 'number', description: 'CUDA 版本下限（113 = 11.3），缺省用配置' },
      data_center_list: { type: 'string', description: '数据中心（westDC3 / beijingDC2），可省略自动选' },
      instance_name: { type: 'string', description: '实例名' },
      start_command: { type: 'string', description: '开机启动命令' },
      hours: { type: 'number', description: '计划运行小时数（用于预算与租约到期）', required: true },
      price_per_hour_yuan: { type: 'number', description: '单价（元/小时），缺省用配置值' },
      confirm: { type: 'boolean', description: '必须显式 true 才会真正创建（涉及真实计费）' },
    },
    async execute(args) {
      if (args?.confirm !== true) {
        return {
          created: false,
          reason: '创建实例会产生真实费用，需显式传 confirm: true。可先用 autoresearch_autodl_estimate 估算。',
          estimate: estimateCost({
            pricePerHourYuan: args?.price_per_hour_yuan ?? cfg.pricePerHourYuan,
            hours: args?.hours,
            budget: { maxTotalYuan: cfg.maxTotalYuan },
          }),
        }
      }
      const options = await withToken()
      const request = {
        gpu_spec_uuid: args?.gpu_spec_uuid ?? cfg.defaultGpuSpec,
        image_uuid: args?.image_uuid,
        req_gpu_amount: args?.req_gpu_amount ?? 1,
        expand_system_disk_by_gb: args?.expand_system_disk_by_gb ?? 0,
        cuda_v_from: args?.cuda_v_from ?? cfg.defaultCudaVersion,
        ...(args?.data_center_list ? { data_center_list: args.data_center_list } : {}),
        ...(args?.instance_name ? { instance_name: args.instance_name } : {}),
        ...(args?.start_command ? { start_command: args.start_command } : {}),
      }
      return provisionInstance({
        request,
        leaseFile: leaseFileOf(cfg),
        token: options.token,
        hours: args?.hours,
        budget: {
          pricePerHourYuan: args?.price_per_hour_yuan ?? cfg.pricePerHourYuan,
          maxTotalYuan: cfg.maxTotalYuan,
        },
      })
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_power',
    description: '开机或关机指定实例。关机不收费但保留磁盘。',
    parameters: {
      instance_uuid: { type: 'string', description: '实例 uuid', required: true },
      action: { type: 'string', enum: ['on', 'off'], description: 'on=开机，off=关机', required: true },
      start_command: { type: 'string', description: '开机时覆盖启动命令' },
    },
    async execute(args) {
      const uuid = args?.instance_uuid
      if (typeof uuid !== 'string' || uuid === '') throw new AutoDLError('必须提供 instance_uuid')
      const options = await withToken()
      return args?.action === 'on'
        ? powerOn(uuid, { startCommand: args?.start_command }, options)
        : powerOff(uuid, options)
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_release',
    description: '释放实例（不可恢复）。要求先关机；需显式 confirm。',
    parameters: {
      instance_uuid: { type: 'string', description: '实例 uuid', required: true },
      confirm: { type: 'boolean', description: '必须显式 true（数据不可恢复）' },
    },
    async execute(args) {
      const uuid = args?.instance_uuid
      if (typeof uuid !== 'string' || uuid === '') throw new AutoDLError('必须提供 instance_uuid')
      if (args?.confirm !== true) {
        return { released: false, reason: '释放会删除实例与磁盘数据，需显式 confirm: true' }
      }
      const options = await withToken()
      return releaseInstance(uuid, options)
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_save_image',
    description: '把实例当前环境保存为自定义镜像。',
    parameters: {
      instance_uuid: { type: 'string', description: '实例 uuid', required: true },
      image_name: { type: 'string', description: '镜像名', required: true },
    },
    async execute(args) {
      const options = await withToken()
      return saveImage(args?.instance_uuid, args?.image_name, options)
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_autodl_cost',
    description: '单实例实时成本：已运行时长与预估花费。只读。',
    parameters: {
      instance_uuid: { type: 'string', description: '实例 uuid', required: true },
      price_per_hour_yuan: { type: 'number', description: '单价（元/小时），缺省用配置值' },
    },
    async execute(args) {
      const options = await withToken()
      return instanceCostReport({
        instanceUuid: args?.instance_uuid,
        token: options.token,
        pricePerHourYuan: args?.price_per_hour_yuan ?? cfg.pricePerHourYuan,
      })
    },
  }))
}

export { ENDPOINTS, GPU_SPECS, DATA_CENTERS, yuan, AutoDLError }
