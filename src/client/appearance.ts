/**
 * The "enable" step for a skin.
 *
 * A skin package registers its theme with ui-theme in its own apply, but dsh's appearance
 * row renders only the three built-ins (light / dark / follow system) and never lists
 * third-party themes — so an installed skin has no UI that can select it, and installing
 * it looks like nothing happened. The market fills that gap.
 *
 * One more gap to cover ourselves: ui-theme persists only built-in preferences to Host
 * settings, never third-party theme ids. So the choice is remembered in localStorage and
 * replayed the moment the skin registers — a skin's client bundle loads asynchronously
 * and is not in the registry when the page first comes up.
 */

import type { ClientContext, ThemeRuntime, ThemeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** Built-in theme ids: dsh's own appearance row owns these; the market does not list them. */
const BUILTIN = new Set(['light', 'dark'])

/** Remembers the chosen skin theme. ui-theme does not persist third-party ids, so we store it ourselves. */
const STORAGE_KEY = 'skin-market.theme'

/** One selectable appearance option. */
export interface AppearanceOption {
  readonly id: string
  /** Whether it ships with dsh (follow system / light / dark). */
  readonly builtin: boolean
  readonly active: boolean
}

/** Data and actions for the appearance section. */
export interface AppearanceFace {
  readonly options: readonly AppearanceOption[]
  readonly select: (id: string) => void
}

const read = (): string | undefined => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined
  } catch {
    // localStorage can be unavailable in private mode; failing to remember does not affect this choice.
    return undefined
  }
}

const write = (id: string): void => {
  try {
    if (id === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // As above — if it cannot be stored, let it go.
  }
}

/**
 * Turn a theme snapshot into the options the appearance section renders.
 * @param snapshot - Theme service snapshot.
 * @returns Follow-system, then built-ins, then registered skin themes, in that order.
 */
export function optionsOf(snapshot: ThemeSnapshot): AppearanceOption[] {
  const options: AppearanceOption[] = [
    { id: 'system', builtin: true, active: snapshot.preference === 'system' },
  ]
  for (const theme of snapshot.themes) {
    options.push({
      id: theme.id,
      builtin: BUILTIN.has(theme.id),
      active: snapshot.preference === theme.id,
    })
  }
  return options
}

/**
 * Replay the previously selected skin after the page loads.
 *
 * A skin's bundle loads asynchronously and is not registered at startup, so this
 * subscribes to changes, switches once that theme actually appears in the registry, and
 * then stops (later choices belong to select).
 * @param ctx - Browser plugin context, used to subscribe to theme/change.
 * @param theme - Theme service.
 * @returns The unsubscribe function.
 */
export function restoreSaved(ctx: ClientContext, theme: ThemeRuntime): () => void {
  const wanted = read()
  if (wanted === undefined || wanted === 'system') return () => {}

  const apply = (snapshot: ThemeSnapshot): boolean => {
    if (snapshot.preference === wanted) return true
    if (!snapshot.themes.some(entry => entry.id === wanted)) return false
    theme.setTheme(wanted)
    return true
  }

  if (apply(theme.getTheme())) return () => {}

  let dispose: () => void = () => {}
  dispose = ctx.on('theme/change', ((snapshot: ThemeSnapshot) => {
    // Once the switch succeeds, remove ourselves: later choices belong to selectTheme.
    if (apply(snapshot)) dispose()
  }) as (...args: never[]) => void)
  return dispose
}

/**
 * Switch appearance and remember the choice.
 * @param theme - Theme service.
 * @param id - A theme id, or `system`.
 */
export function selectTheme(theme: ThemeRuntime, id: string): void {
  theme.setTheme(id)
  write(id)
}
