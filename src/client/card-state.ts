/** 单张卡片的安装/卸载状态机，与它的归约函数。 */

import type { InstallErrorCode, InstallEvent } from '../types.ts'

/** 正在进行的动作。 */
export type CardVerb = 'install' | 'uninstall'

/** 一张卡片的当前状态。 */
export type CardState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly verb: CardVerb; readonly log: readonly string[] }
  | { readonly kind: 'done'; readonly verb: CardVerb }
  | {
    readonly kind: 'error'
    readonly code: InstallErrorCode
    readonly message: string
    readonly detail?: string
    readonly log: readonly string[]
  }

/** 空闲态常量，省得到处新建对象。 */
export const IDLE: CardState = { kind: 'idle' }

/** 日志只留尾部：安装输出可能上百行，界面里没人会往上翻那么多。 */
const LOG_LIMIT = 60

/**
 * 把一条过程事件归约进卡片状态。
 * @param state - 当前状态。
 * @param event - 收到的事件。
 * @param verb - 本次动作。
 * @returns 新状态。
 */
export function reduce(state: CardState, event: InstallEvent, verb: CardVerb): CardState {
  const log = state.kind === 'working' || state.kind === 'error' ? state.log : []

  switch (event.type) {
    case 'log':
      return { kind: 'working', verb, log: [...log, event.line].slice(-LOG_LIMIT) }
    case 'step':
      return { kind: 'working', verb, log }
    case 'done':
      return { kind: 'done', verb }
    case 'error':
      return {
        kind: 'error',
        code: event.code,
        message: event.message,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        log,
      }
  }
}
