/** Contents of the Installed and Diagnostics tabs. Neither depends on the registry; both work offline. */

import type { JSX } from 'react'
import type { Diagnostics, InstalledSkin } from '../types.ts'
import type { AppearanceOption } from './appearance.ts'
import type { CardState } from './card-state.ts'
import styles from './market.module.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** Appearance section props. */
export interface AppearancePickerProps {
  readonly options: readonly AppearanceOption[]
  readonly t: Translate
  readonly onSelect: (id: string) => void
}

/** Built-ins have localised names; a skin's theme is shown under its own id. */
const BUILTIN_LABEL: Record<string, string> = {
  system: 'appearance.system',
  light: 'appearance.light',
  dark: 'appearance.dark',
}

/** Translations for built-ins; skin themes display their id verbatim. */
function labelOf(id: string, t: Translate): string {
  const key = BUILTIN_LABEL[id]
  return key === undefined ? id : t(key)
}

/**
 * The appearance picker — the step that actually makes an installed skin take effect.
 *
 * dsh's own appearance row renders only the three built-ins, so once a skin registers with the
 * theme service no UI can select it. This lists every theme in the registry.
 * @param props - Options, copy and callbacks.
 * @returns The section element.
 */
export function AppearancePicker({ options, t, onSelect }: AppearancePickerProps): JSX.Element {
  return (
    <section className={styles.appearance}>
      <h3 className={styles.appearanceTitle}>
        {t('appearance.title')}
        <span className={styles.appearanceCount}>{options.length}</span>
      </h3>
      <div className={styles.cubes}>
        {options.map(option => (
          <button
            key={option.id}
            className={styles.cube}
            type="button"
            aria-pressed={option.active}
            onClick={() => { onSelect(option.id) }}
          >
            {labelOf(option.id, t)}
          </button>
        ))}
      </div>
      <p className={styles.appearanceHint}>{t('appearance.hint')}</p>
    </section>
  )
}

/** Installed panel props. */
export interface InstalledPanelProps {
  readonly items: readonly InstalledSkin[]
  readonly states: ReadonlyMap<string, CardState>
  readonly t: Translate
  readonly onUninstall: (packageName: string) => void
  /** The active theme id, used to mark which skin is enabled. */
  readonly activeThemeId?: string
  /** Enable a skin. Themes are single-select, so switching to one replaces the other. */
  readonly onEnable: (themeId: string) => void
  /** Why the last Enable click failed, shown above the list. Absent while nothing has failed. */
  readonly failure?: string
}

/**
 * Skins installed on this machine.
 * @param props - List, state and callbacks.
 * @returns The panel element.
 */
export function InstalledPanel(
  { items, states, t, onUninstall, activeThemeId, onEnable, failure }: InstalledPanelProps,
): JSX.Element {
  if (items.length === 0) {
    return (
      <div className={styles.empty}>
        {t('installed.empty')}
        <div className={styles.emptyHint}>{t('installed.emptyHint')}</div>
      </div>
    )
  }

  return (
    <div className={styles.installedList}>
      {failure !== undefined && (
        <div className={styles.empty}>
          {t('installed.enableFailed')}
          <div className={styles.emptyHint}>{failure}</div>
        </div>
      )}
      {items.map((item) => {
        const state = states.get(item.packageName) ?? { kind: 'idle' as const }
        const busy = state.kind === 'working'
        const active = item.themeId !== undefined && item.themeId === activeThemeId
        return (
          <article className={styles.installedRow} key={item.packageName}>
            {/*
              Icons come from the host's local route rather than the registry's iconUrl — this screen
              exists to work offline, and an icon should not be the one thing that needs the network.
              A package with no preview returns 404, and onError swaps in the placeholder.
            */}
            <img
              className={styles.installedIcon}
              src={`/skin-market/api/icon?package=${encodeURIComponent(item.packageName)}`}
              alt=""
              loading="lazy"
              onError={(event) => { event.currentTarget.classList.add(styles.iconMissing ?? '') }}
            />
            <div className={styles.installedMain}>
              {/*
                The full install URL lives in the title rather than taking a line of its own.
                It is debugging information — anyone who wants it can read the full output on the
                Diagnostics tab, whereas a permanently displayed long URL with a horizontal
                scrollbar only makes this row messy.
              */}
              <h3
                className={styles.installedName}
                title={item.spec !== undefined ? `${item.packageName}\n${item.spec}` : item.packageName}
              >
                {item.packageName}
              </h3>
              <p className={styles.installedMeta}>
                {item.version !== undefined && <span>v{item.version}</span>}
                {item.themeId !== undefined && <><span>·</span><span>{item.themeId}</span></>}
                {active && <><span>·</span><span className={styles.activeMark}>{t('installed.active')}</span></>}
                {item.disabled && <><span>·</span><span>{t('installed.disabled')}</span></>}
              </p>
            </div>

            <div className={styles.installedActions}>
              {state.kind === 'done'
                ? (
                  <button
                    className={`${styles.primary} ${styles.done}`}
                    type="button"
                    onClick={() => { window.location.reload() }}
                  >
                    {t('card.reload')}
                  </button>
                )
                : (
                  <>
                    {/*
                      No enable button for packages whose themeId cannot be read: those skins did not write
                      skin.json to spec, and guessing an id for setTheme simply fails to switch with
                      no diagnosable reason
                    */}
                    {item.themeId !== undefined && (
                      <button
                        className={active ? styles.ghost : styles.primary}
                        type="button"
                        disabled={busy}
                        // Disable = switch back to follow-system. The skin stays installed, it just stops applying
                        onClick={() => { onEnable(active ? 'system' : item.themeId!) }}
                      >
                        {t(active ? 'installed.disable' : 'installed.enable')}
                      </button>
                    )}
                    <button
                      className={styles.ghost}
                      type="button"
                      disabled={busy}
                      onClick={() => { onUninstall(item.packageName) }}
                    >
                      {t(busy ? 'card.uninstalling' : 'card.uninstall')}
                    </button>
                  </>
                )}
            </div>

            {busy && state.log.length > 0 && (
              <pre className={styles.log}>{state.log.join('\n')}</pre>
            )}
            {state.kind === 'error' && (
              <div className={styles.error}>
                <div className={styles.errorTitle}>{state.message}</div>
                {state.detail !== undefined && <div>{state.detail}</div>}
              </div>
            )}
          </article>
        )
      })}
      <p className={styles.emptyHint}>{t('installed.local')}</p>
    </div>
  )
}

/** Diagnostics panel props. */
export interface DiagnosticsPanelProps {
  readonly data: Diagnostics | undefined
  readonly t: Translate
  readonly onRefresh: () => void
}

const STATUS_CLASS = {
  ok: styles.statusOk,
  warn: styles.statusWarn,
  error: styles.statusError,
} as const

/**
 * Environment self-check: pnpm, profile, registry connectivity, and the last install output.
 * @param props - Data and the refresh callback.
 * @returns The panel element.
 */
export function DiagnosticsPanel({ data, t, onRefresh }: DiagnosticsPanelProps): JSX.Element {
  if (data === undefined) return <div className={styles.empty}>{t('diag.loading')}</div>

  return (
    <div className={styles.list}>
      {data.rows.map(row => (
        <div className={styles.diagRow} key={row.key}>
          <span className={styles.diagKey}>{row.key}</span>
          <span className={styles.diagValue}>{row.value}</span>
          <span className={STATUS_CLASS[row.status]}>{row.status === 'ok' ? 'ok' : row.status === 'warn' ? 'check' : 'error'}</span>
          {row.hint !== undefined && <span className={styles.hint}>{row.hint}</span>}
        </div>
      ))}
      <div className={styles.sortbar}>
        <button className={styles.ghost} type="button" onClick={onRefresh}>{t('diag.refresh')}</button>
      </div>
      {data.lastInstallLog !== undefined && (
        <>
          <p className={styles.emptyHint}>{t('diag.log')}</p>
          <pre className={styles.log}>{data.lastInstallLog}</pre>
        </>
      )}
    </div>
  )
}
