/**
 * AutoDL 开放 API 客户端（Pro 实例 API）。
 *
 * ## 为什么单独一层，而不是直接在工具里 fetch
 *
 * 三个理由，都是实测踩出来的：
 *
 * 1. **端点不能猜。** 早期按「/dev/instance/list」这类直觉命名去试，全部 404。
 *    真实路径是 `/api/v1/dev/instance/pro/list` —— 带 `pro` 段。端点清单以
 *    `https://www.autodl.com/docs/instance_pro_api/` 为准，本文件是它的唯一映射处。
 * 2. **GET 带 body。** 官方文档把 snapshot / status 写成 GET，却要求 JSON
 *    request body。用 `fetch` 必须显式 `body`，不能按 REST 惯例把它们改成 POST。
 * 3. **错误形态不统一。** HTTP 200 里也可能是 `code != "Success"`（实测
 *    `/wallet/balance` 传错参数时返回 `RequestParameterIsWrong`）。只看
 *    `response.ok` 会把失败当成功，所以这里统一在 `call()` 里判 `code`。
 *
 * ## 密钥边界
 *
 * token 只从调用方传入或从环境变量读，**本模块不写盘、不打印、不回显**。
 * 落盘位置由上层决定（`.dsh-home/` 已被 gitignore）。
 *
 * @module dsh-autoresearch-autodl/lib
 */

/** 官方 API 根地址。 */
export const API_HOST = 'https://api.autodl.com'

/**
 * 计费单位：余额与价格字段都是「千分之一元」。
 *
 * 官方样例：`assets: 1000` = 1 元。实测账户 `assets: 30840` = 30.84 元。
 * 所有对外金额一律经 `yuan()` 换算，避免调用方各自去掉三位。
 */
export const MILLI_PER_YUAN = 1000

/** 把千分之一元换算成元（保留 2 位）。 */
export function yuan(milli) {
  const n = Number(milli)
  return Number.isFinite(n) ? Math.round(n) / MILLI_PER_YUAN : null
}

/** AutoDL 调用失败。`code` 是官方响应里的字符串码，便于上层分流。 */
export class AutoDLError extends Error {
  constructor(message, { code, status, endpoint, requestId } = {}) {
    super(message)
    this.name = 'AutoDLError'
    this.code = code ?? null
    this.status = status ?? null
    this.endpoint = endpoint ?? null
    this.requestId = requestId ?? null
  }
}

/** 官方端点表。集中在这里，是为了让「端点写错」只有一个地方可错。 */
export const ENDPOINTS = Object.freeze({
  balance: { method: 'POST', path: '/api/v1/dev/wallet/balance' },
  instanceList: { method: 'POST', path: '/api/v1/dev/instance/pro/list' },
  instanceCreate: { method: 'POST', path: '/api/v1/dev/instance/pro/create' },
  instanceSnapshot: { method: 'GET', path: '/api/v1/dev/instance/pro/snapshot' },
  instanceStatus: { method: 'GET', path: '/api/v1/dev/instance/pro/status' },
  instancePowerOn: { method: 'POST', path: '/api/v1/dev/instance/pro/power_on' },
  instancePowerOff: { method: 'POST', path: '/api/v1/dev/instance/pro/power_off' },
  instanceRelease: { method: 'POST', path: '/api/v1/dev/instance/pro/release' },
  imageSave: { method: 'POST', path: '/api/v1/dev/instance/pro/image/save' },
  imageList: { method: 'POST', path: '/api/v1/dev/instance/pro/image/private/list' },
  nfsMount: { method: 'POST', path: '/api/v1/dev/exclusive_nfs/mount' },
})

/**
 * GPU 规格（文档附录）。
 *
 * `id` 用于 `create` 的 `gpu_spec_uuid`。内场红线 1/QA15 只接受 H20 / L20，
 * AutoDL 提供的这些型号**都不在内场白名单里** —— 这是两台不同机器：
 * 内场跑正式评分，AutoDL 跑专家自己的探索与预跑。别把两边混为一谈。
 */
export const GPU_SPECS = Object.freeze([
  { id: 'h800', name: 'H800-80G', tier: '通用型' },
  { id: 'v-48g', name: '4090-48G', tier: '通用型' },
  { id: 'pro6000-p', name: 'PRO6000-96G', tier: '性能型' },
  { id: 'v-32g-p', name: '4080(S)-32G', tier: '性能型' },
  { id: 'v-48g-350w', name: '3090-48G', tier: '通用型' },
  { id: '5090-p', name: '5090-32G', tier: '性能型' },
  { id: '4090D', name: '4090D', tier: '通用型' },
])

/** 数据中心代码（文档附录：westDC3 西北区 / beijingDC2 北京区）。 */
export const DATA_CENTERS = Object.freeze([
  { id: 'westDC3', name: '西北区' },
  { id: 'beijingDC2', name: '北京区' },
])

/** 实例状态里视为「已经可以 SSH 进去」的那些。 */
export const RUNNING_STATUS = Object.freeze(['running'])

/** 实例状态里视为「已停止、可开机」的那些。 */
export const STOPPED_STATUS = Object.freeze(['shutdown', 'stopped', 'power_off'])

/**
 * 创建请求的字段约束（来自文档，用于本地先挡一次明显错误）。
 *
 * 本地校验不能替代服务端校验，但能在**花钱之前**拦住参数错误 ——
 * 创建实例是按量计费的，一次误创建就是真实支出。
 */
export const CREATE_LIMITS = Object.freeze({
  req_gpu_amount: { min: 1, max: 4 },
  expand_system_disk_by_gb: { min: 0, max: 500 },
})

/**
 * 调一次 API。
 *
 * @param {{method: string, path: string}} endpoint
 * @param {object} body
 * @param {{token: string, timeoutMs?: number, fetchImpl?: Function}} options
 * @returns {Promise<object>} 官方响应里的 `data`
 */
export async function call(endpoint, body, options) {
  const { token, timeoutMs = 30_000, fetchImpl = globalThis.fetch } = options ?? {}
  if (typeof token !== 'string' || token.trim() === '') {
    throw new AutoDLError('缺少 AutoDL token：请在设置里配置或显式传入', { endpoint: endpoint.path })
  }
  if (typeof fetchImpl !== 'function') {
    throw new AutoDLError('当前运行时没有 fetch，无法调用 AutoDL API', { endpoint: endpoint.path })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(API_HOST + endpoint.path, {
      method: endpoint.method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      // GET 也要带 body —— 官方 snapshot / status 就是这么要求的。
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (error?.message ?? '网络错误')
    throw new AutoDLError(`调用 ${endpoint.path} 失败：${reason}`, { endpoint: endpoint.path })
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new AutoDLError(`调用 ${endpoint.path} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`,
      { status: response.status, endpoint: endpoint.path })
  }

  // 关键：HTTP 200 不代表成功。官方在 200 里返回 code != Success。
  if (payload?.code !== 'Success') {
    throw new AutoDLError(
      `AutoDL 拒绝 ${endpoint.path}：${payload?.code ?? '(无 code)'} ${payload?.msg ?? ''}`.trim(),
      {
        code: payload?.code ?? null,
        status: response.status,
        endpoint: endpoint.path,
        requestId: payload?.request_id ?? null,
      },
    )
  }
  return payload.data ?? null
}

/** 查余额。返回元。 */
export async function readBalance(options) {
  const data = await call(ENDPOINTS.balance, {}, options)
  return {
    assets: yuan(data?.assets),
    accumulate: yuan(data?.accumulate),
    voucher: yuan(data?.voucher_balance),
    raw: data,
  }
}

/** 列实例；返回归一化后的实例数组与分页信息。 */
export async function listInstances(options = {}) {
  const data = await call(ENDPOINTS.instanceList, {
    page_index: options.pageIndex ?? 1,
    page_size: options.pageSize ?? 20,
  }, options)
  const list = Array.isArray(data?.list) ? data.list : []
  return {
    instances: list.map(normalizeInstance),
    page: {
      index: data?.page_index ?? 1,
      size: data?.page_size ?? 0,
      total: data?.result_total ?? list.length,
      maxPage: data?.max_page ?? 1,
    },
  }
}

/**
 * 归一化一个实例对象。
 *
 * 官方把 `expired_at` / `started_at` / `stopped_at` / `timed_shutdown_at`
 * 返回成 `{Time, Valid}` 包装体，未设置时 `Valid=false`、`Time` 是零值。
 * 直接把它当字符串用会得到 `[object Object]`，这里统一摊平成 ISO 串或 null。
 */
export function normalizeInstance(raw) {
  const timeOf = (value) => {
    if (value === null || value === undefined) return null
    if (typeof value === 'string') return value
    if (typeof value === 'object' && value.Valid === true && value.Time) return String(value.Time)
    return null
  }
  return {
    uuid: raw?.uuid ?? null,
    name: raw?.name ?? null,
    status: raw?.status ?? null,
    subStatus: raw?.sub_status ?? null,
    regionSign: raw?.region_sign ?? null,
    regionName: raw?.region_name ?? null,
    gpuSpecUuid: raw?.gpu_spec_uuid ?? null,
    gpuAmount: raw?.req_gpu_amount ?? null,
    chargeType: raw?.charge_type ?? null,
    startMode: raw?.start_mode ?? null,
    machineAlias: raw?.machine_alias ?? null,
    createdAt: timeOf(raw?.created_at) ?? raw?.created_at ?? null,
    startedAt: timeOf(raw?.started_at),
    stoppedAt: timeOf(raw?.stopped_at),
    expiredAt: timeOf(raw?.expired_at),
    timedShutdownAt: timeOf(raw?.timed_shutdown_at),
    raw,
  }
}

/** 查单个实例详情（含 SSH 连接信息与**价格**）。 */
export async function readSnapshot(instanceUuid, options) {
  const data = await call(ENDPOINTS.instanceSnapshot, { instance_uuid: instanceUuid }, options)
  return {
    regionSign: data?.region_sign ?? null,
    gpuAlias: data?.snapshot_gpu_alias_name ?? null,
    chipCorp: data?.chip_corp ?? null,
    cpuArch: data?.cpu_arch ?? null,
    // 价格：文档只给了「折扣后 / 折扣前」的按量计费价，**没写货币与计费时长**。
    // 原样保留数值，不臆测单位；展示层用 raw 标注来源。
    paygPrice: data?.payg_price ?? null,
    originPaygPrice: data?.origin_pay_price ?? null,
    sshCommand: data?.ssh_command ?? null,
    sshHost: data?.proxy_host ?? null,
    sshPort: data?.ssh_port ?? null,
    rootPassword: data?.root_password ?? null,
    jupyterDomain: data?.jupyter_domain ?? null,
    jupyterToken: data?.jupyter_token ?? null,
    systemDiskSize: data?.system_init_disk_size ?? null,
    expandSystemDiskSize: data?.expand_system_disk_size ?? null,
    usage: data?.usage_info ?? null,
    raw: data,
  }
}

/** 查实例运行状态（只返回字符串状态）。 */
export async function readInstanceStatus(instanceUuid, options) {
  const data = await call(ENDPOINTS.instanceStatus, { instance_uuid: instanceUuid }, options)
  return typeof data === 'string' ? data : (data?.status ?? null)
}

/** 校验创建参数。返回问题清单（空数组表示本地检查通过）。 */
export function validateCreateRequest(request) {
  const problems = []
  const need = (field, label) => {
    const v = request?.[field]
    if (v === undefined || v === null || v === '') problems.push(`缺少 ${label}（${field}）`)
  }
  const range = (field, limit) => {
    const v = Number(request?.[field])
    if (!Number.isFinite(v)) { problems.push(`${field} 必须是数字`); return }
    if (v < limit.min || v > limit.max) problems.push(`${field} 必须在 ${limit.min}–${limit.max} 之间，当前 ${v}`)
  }

  need('gpu_spec_uuid', 'GPU 规格')
  need('image_uuid', '镜像')
  need('cuda_v_from', 'CUDA 版本下限')
  for (const [field, limit] of Object.entries(CREATE_LIMITS)) range(field, limit)
  // CUDA 版本下限是按位编码的整数（113 = 11.3）。传字符串或小数都会被服务端拒，
  // 但那时实例可能已进入创建流程 —— 本地先挡。
  const cuda = Number(request?.cuda_v_from)
  if (request?.cuda_v_from !== undefined && request?.cuda_v_from !== null
      && (!Number.isInteger(cuda) || cuda <= 0)) {
    problems.push(`cuda_v_from 必须是正整数（113 = CUDA 11.3），当前 ${JSON.stringify(request.cuda_v_from)}`)
  }

  const specIds = new Set(GPU_SPECS.map((s) => s.id))
  if (request?.gpu_spec_uuid && !specIds.has(request.gpu_spec_uuid)) {
    problems.push(`未知的 gpu_spec_uuid：${request.gpu_spec_uuid}（可选：${[...specIds].join(', ')}）`)
  }
  const dc = request?.data_center_list
  if (dc !== undefined && dc !== null && dc !== '') {
    const valid = new Set(DATA_CENTERS.map((d) => d.id))
    for (const id of Array.isArray(dc) ? dc : [dc]) {
      if (!valid.has(id)) problems.push(`未知的 data_center_list：${id}（可选：${[...valid].join(', ')}）`)
    }
  }
  return problems
}

/** 创建实例。返回新实例 uuid。 */
export async function createInstance(request, options) {
  const problems = validateCreateRequest(request)
  if (problems.length > 0) {
    throw new AutoDLError(`创建参数不合法：${problems.join('；')}`, { endpoint: ENDPOINTS.instanceCreate.path })
  }
  const data = await call(ENDPOINTS.instanceCreate, request, options)
  return typeof data === 'string' ? data : (data?.instance_uuid ?? data?.uuid ?? null)
}

/** 开机。`startCommand` 会覆盖创建时给的启动命令。 */
export async function powerOn(instanceUuid, { startCommand } = {}, options) {
  const body = { instance_uuid: instanceUuid }
  if (typeof startCommand === 'string' && startCommand !== '') body.start_command = startCommand
  await call(ENDPOINTS.instancePowerOn, body, options)
  return { ok: true, instanceUuid }
}

/** 关机。 */
export async function powerOff(instanceUuid, options) {
  await call(ENDPOINTS.instancePowerOff, { instance_uuid: instanceUuid }, options)
  return { ok: true, instanceUuid }
}

/**
 * 释放实例（不可恢复）。
 *
 * 文档要求先关机；这里**在本地先查一次状态**，避免把「没关机就释放」的
 * 服务端报错变成一个语焉不详的失败。查不到状态时如实报错，不猜。
 */
export async function releaseInstance(instanceUuid, options) {
  const status = await readInstanceStatus(instanceUuid, options)
  if (!STOPPED_STATUS.includes(String(status))) {
    throw new AutoDLError(
      `释放前必须先关机：当前状态 ${status ?? '(未知)'}。先调用 power_off，确认停止后再释放。`,
      { endpoint: ENDPOINTS.instanceRelease.path },
    )
  }
  await call(ENDPOINTS.instanceRelease, { instance_uuid: instanceUuid }, options)
  return { ok: true, instanceUuid, releasedFrom: status }
}

/** 保存镜像。返回 image_uuid。 */
export async function saveImage(instanceUuid, imageName, options) {
  if (typeof imageName !== 'string' || imageName.trim() === '') {
    throw new AutoDLError('保存镜像必须给 image_name', { endpoint: ENDPOINTS.imageSave.path })
  }
  const data = await call(ENDPOINTS.imageSave, { instance_uuid: instanceUuid, image_name: imageName }, options)
  return { imageUuid: data?.image_uuid ?? null, raw: data }
}

/** 列自定义镜像。 */
export async function listImages(options = {}) {
  const data = await call(ENDPOINTS.imageList, {
    page_index: options.pageIndex ?? 1,
    page_size: options.pageSize ?? 20,
  }, options)
  const list = Array.isArray(data?.list) ? data.list : []
  return {
    images: list.map((i) => ({
      uuid: i?.image_uuid ?? null,
      name: i?.name ?? null,
      status: i?.status ?? null,
      sizeBytes: i?.image_size ?? null,
      createdAt: i?.create_at ?? null,
      isDesktop: i?.is_desktop ?? false,
    })),
    page: {
      index: data?.page_index ?? 1,
      size: data?.page_size ?? 0,
      total: data?.result_total ?? list.length,
      maxPage: data?.max_page ?? 1,
    },
  }
}
