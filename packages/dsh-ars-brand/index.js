/**
 * dsh-ars-brand 的宿主半边。
 *
 * 身份层只需要客户端半边（槽位占用）——这里保持最小：不注册工具、不注册路由、
 * 不注入任何服务，因此本插件在任何 profile 里都能加载，不会成为激活约束。
 *
 * 之所以仍然要有宿主半边：bundle 行的 `name` 必须指向一个可加载的 Cordis 插件。
 */

export const name = 'ars-brand'

/** 无依赖：身份层不消费任何服务。 */
export const inject = []

export function apply() {
  // 有意为空。品牌位与「关于」页都由 client.js 通过槽位贡献。
}
