/**
 * client 半：把皮肤市场注册成 Settings 里的一页。
 *
 * 用 settings.section 而不是挤进 settings.plugins.tab —— 皮肤市场是一件独立的事，
 * 不是插件管理的一个子页。
 */

// 只为把设置外壳的 slot 声明（settings.section）与 ctx.locale 的合并拉进编译面；
// 跨插件协作走服务，绝不做值导入（client bundle 的纯净性门禁会拦）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentType } from 'react'
import { createApi } from './api.ts'
import { SkinMarketSection, type SkinMarketInjected } from './SkinMarketSection.tsx'
import { en, zh } from './locales.ts'

export type { SkinMarketInjected } from './SkinMarketSection.tsx'
export type { MarketApi } from './api.ts'
export type { CardState } from './card-state.ts'

/** 本插件拥有的词典命名空间。 */
export const NS = 'settings.skinMarket'

/** 插件版本，页头展示。发版时与 package.json 一起改。 */
const VERSION = '0.1.0'

/** 需要的浏览器侧服务。 */
export const inject = ['slots', 'locale']

/**
 * 挂载市场页。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skin-market: dictionaries')

  const t = ctx.locale.bind(NS)
  const api = createApi()
  const injected = (): SkinMarketInjected => ({ api, t, version: VERSION })

  // slots.inject 跟随 slot 的延迟声明与重新声明，因此不必 import 设置外壳。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skin-market',
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, SkinMarketSection as ComponentType<never>))
}
