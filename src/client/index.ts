/**
 * Client half: registers the skin market as a page in Settings.
 *
 * It uses settings.section rather than squeezing into settings.plugins.tab — the skin
 * market is its own thing, not a sub-page of plugin management.
 */

// Type-only, purely to bring the settings shell's slot declaration (settings.section)
// and the ctx.locale merge into the compilation surface. Cross-plugin collaboration goes
// through services; never a value import (the client bundle purity gate blocks it).
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

/** The locale namespace this plugin owns. */
export const NS = 'settings.skinMarket'

/** Plugin version, shown in the page header. Bump it together with package.json. */
const VERSION = '0.1.1'

/** Browser-side services required. */
export const inject = ['slots', 'locale']

/**
 * Mount the market page.
 * @param ctx - Browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skin-market: dictionaries')

  const t = ctx.locale.bind(NS)
  const api = createApi()

  /**
   * The theme service, filled once ui-theme is ready.
   *
   * 🔴 **Not `ctx.get('theme')` at apply time.** ui-theme ships with the web bundle but this plugin does not
   * declare it in `inject`, so at apply time the service may not be ready — and `get` then hands back a handle
   * that reads fine yet drives nothing: `getTheme()` returns the built-ins, so the appearance row renders and the
   * enable buttons appear, while `setTheme` throws `theme "…" is not registered` because every skin registered on
   * the live instance. Measured on dsh 0.1.2-alpha.2: clicking Enable did nothing at all, and switching to the
   * built-in `dark` through this same handle failed too — which is what proved the handle, not the skins, was the
   * broken part.
   *
   * `ctx.inject` keeps ui-theme optional (a bundle without it simply never runs this callback, and the market
   * still browses and installs) while guaranteeing the instance is the ready, current one.
   */
  let theme: ThemeRuntime | undefined
  ctx.inject(['theme'], (ready) => {
    theme = ready.get<ThemeRuntime>('theme')
    if (theme === undefined) return
    const runtime = theme
    // Third-party theme ids never reach Host settings, so we restore the last choice after a restart.
    ctx.effect(() => restoreSaved(ctx, runtime), 'skin-market: restore selected skin')
  })

  /*
   * Read `theme` at call time, never captured.
   *
   * `injected` is a factory the slot calls when the panel renders, which is after the user opens Settings — long
   * after ui-theme is ready. Capturing the value here instead would freeze whatever was true at apply time, the
   * very bug described above.
   */
  const appearance = {
    options: () => (theme === undefined ? [] : optionsOf(theme.getTheme())),
    subscribe: (listener: () => void) => ctx.on('theme/change', listener),
    select: (id: string) => {
      if (theme === undefined) throw new Error('theme service is not available in this bundle')
      selectTheme(theme, id)
    },
  }

  const injected = (): SkinMarketInjected => ({ api, t, version: VERSION, appearance })

  // slots.inject follows the slot's late declaration and re-declaration, so the settings shell need not be imported.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skin-market',
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, SkinMarketSection as ComponentType<never>))
}
