/** The install/uninstall state machine for one card, and its reducer. */

import type { InstallErrorCode, InstallEvent } from '../types.ts'

/** The action in progress. */
export type CardVerb = 'install' | 'uninstall'

/** Current state of one card. */
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

/** Idle constant, so we do not allocate a new object everywhere. */
export const IDLE: CardState = { kind: 'idle' }

/** Keep only the tail of the log: install output can run to hundreds of lines and nobody scrolls that far. */
const LOG_LIMIT = 60

/**
 * Reduce one progress event into the card state.
 * @param state - Current state.
 * @param event - The event received.
 * @param verb - The action being performed.
 * @returns The new state.
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
