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
import type { ClientContext, ThemeRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentType } from 'react'
import { createApi } from './api.ts'
import { optionsOf, restoreSaved, selectTheme } from './appearance.ts'
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

  // ui-theme 是 web 组合的标配，但不做硬依赖：没有它时市场照样能逛能装，
  // 只是不提供「应用皮肤」那一步。
  const theme = ctx.get<ThemeRuntime>('theme')
  if (theme !== undefined) {
    // 第三方主题 id 不进 Host settings，重启后得由我们把上次的选择放回去。
    ctx.effect(() => restoreSaved(ctx, theme), 'skin-market: restore selected skin')
  }

  const appearance = theme === undefined ? undefined : {
    options: () => optionsOf(theme.getTheme()),
    subscribe: (listener: () => void) => ctx.on('theme/change', listener),
    select: (id: string) => { selectTheme(theme, id) },
  }

  const injected = (): SkinMarketInjected => ({
    api, t, version: VERSION, ...(appearance === undefined ? {} : { appearance }),
  })

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
