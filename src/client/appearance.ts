/**
 * 皮肤的「启用」这一环。
 *
 * 皮肤包在自己的 apply 里把主题 `register` 进 ui-theme，但 dsh 的外观设置行
 * 只渲染固定的三个内置项（浅色 / 深色 / 跟随系统），不列第三方主题 —— 于是
 * 装上的皮肤没有任何界面能选中它，看起来就是「装了没反应」。市场补这一环。
 *
 * 另有一处得自己兜：ui-theme 只把内置偏好写进 Host settings，第三方主题 id
 * 不持久化。所以这里用 localStorage 记住选择，并在皮肤注册进来的那一刻重放 ——
 * 皮肤的 client bundle 是异步加载的，页面刚起来时它还不在注册表里。
 */

import type { ClientContext, ThemeRuntime, ThemeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** 内置主题 id：这几个由 dsh 自己的外观行管，不归市场列。 */
const BUILTIN = new Set(['light', 'dark'])

/** 记住用户选的皮肤主题。ui-theme 不为第三方 id 持久化，只能自己存。 */
const STORAGE_KEY = 'skin-market.theme'

/** 一个可选的外观项。 */
export interface AppearanceOption {
  readonly id: string
  /** 是否为 dsh 自带（跟随系统 / 浅色 / 深色）。 */
  readonly builtin: boolean
  readonly active: boolean
}

/** 外观区块的数据与操作。 */
export interface AppearanceFace {
  readonly options: readonly AppearanceOption[]
  readonly select: (id: string) => void
}

const read = (): string | undefined => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined
  } catch {
    // 隐私模式下 localStorage 可能不可用；记不住不影响这次选择。
    return undefined
  }
}

const write = (id: string): void => {
  try {
    if (id === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // 同上，存不下就算了。
  }
}

/**
 * 把主题快照转成外观区块要渲染的选项。
 * @param snapshot - 主题服务快照。
 * @returns 跟随系统 + 内置 + 已注册的皮肤主题，按此顺序。
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
 * 页面加载后重放上次选中的皮肤。
 *
 * 皮肤的 bundle 是异步加载的，刚启动时它还没注册；所以这里订阅变化，等到那个
 * 主题真的出现在注册表里再切过去，切完就不再管（用户之后的选择由 select 负责）。
 * @param ctx - 浏览器插件上下文，用来订阅 theme/change。
 * @param theme - 主题服务。
 * @returns 取消订阅的函数。
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
    // 切成功就撤掉自己：之后的选择归 selectTheme 管，这里不再插手。
    if (apply(snapshot)) dispose()
  }) as (...args: never[]) => void)
  return dispose
}

/**
 * 切换外观，并记住这次选择。
 * @param theme - 主题服务。
 * @param id - 主题 id 或 `system`。
 */
export function selectTheme(theme: ThemeRuntime, id: string): void {
  theme.setTheme(id)
  write(id)
}
