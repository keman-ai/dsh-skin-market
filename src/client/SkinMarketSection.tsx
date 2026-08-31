/**
 * The skin market settings page: three tabs (Discover / Installed / Diagnostics).
 *
 * The component owns UI state only; the registry URL, caching and the install allowlist live in the host half.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { CatalogPage, Diagnostics, InstalledSkin, SkinEntry } from '../types.ts'
import type { MarketApi } from './api.ts'
import type { AppearanceOption } from './appearance.ts'
import { IDLE, reduce, type CardState, type CardVerb } from './card-state.ts'
import { SkinCard, cardKeyOf } from './SkinCard.tsx'
import { AppearancePicker, DiagnosticsPanel, InstalledPanel } from './panels.tsx'
import styles from './market.module.css'

/** The domain surface injected by the slot's inject factory. */
export interface SkinMarketInjected {
  readonly api: MarketApi
  readonly t: (key: string, params?: Record<string, string | number>) => string
  /** Plugin version, shown in the page header. */
  readonly version: string
  /**
   * The appearance surface. Undefined when the host bundle has no ui-theme — the market then
   * only installs and does not apply, and the appearance section is not rendered at all.
   */
  readonly appearance?: {
    readonly options: () => readonly AppearanceOption[]
    readonly subscribe: (listener: () => void) => () => void
    readonly select: (id: string) => void
  }
}

type Tab = 'discover' | 'installed' | 'diagnostics'

/** Search debounce: hitting the server on every keystroke saturates upstream and makes the list jitter. */
const SEARCH_DEBOUNCE_MS = 350

/** The values are defined by the registry, not named by us: popular / latest / name. */
const SORTS = [
  { key: 'popular', label: 'sort.popular' },
  { key: 'latest', label: 'sort.latest' },
  { key: 'name', label: 'sort.name' },
] as const

/**
 * The market page.
 * @param props - The injected domain surface.
 * @returns The page element.
 */
export function SkinMarketSection({ api, t, version, appearance }: SkinMarketInjected): JSX.Element {
  const [tab, setTab] = useState<Tab>('discover')
  const [term, setTerm] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<string>('popular')
  const [page, setPage] = useState<CatalogPage | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /** Why the last Enable click did not switch the skin; cleared on the next attempt. */
  const [enableFailure, setEnableFailure] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [installed, setInstalled] = useState<readonly InstalledSkin[]>([])
  const [diagnostics, setDiagnostics] = useState<Diagnostics | undefined>(undefined)
  const [states, setStates] = useState<ReadonlyMap<string, CardState>>(new Map())
  const [themes, setThemes] = useState<readonly AppearanceOption[]>(() => appearance?.options() ?? [])
  const builtinThemes = themes.filter(option => option.builtin)
  /** The currently active theme id, used by the installed list to mark which skin is enabled. */
  const activeThemeId = themes.find(option => option.active && !option.builtin)?.id

  // A skin's bundle loads asynchronously, so its theme registers after the page is already up.
  useEffect(() => {
    if (appearance === undefined) return
    setThemes(appearance.options())
    return appearance.subscribe(() => { setThemes(appearance.options()) })
  }, [appearance])

  // Events can still arrive after unmount; this guards against setState on an unmounted component.
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(term) }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [term])

  const loadCatalog = useCallback(async () => {
    setLoading(true)
    setFailure(undefined)
    try {
      const result = await api.catalog({ q: query, sort, page: 1 })
      if (alive.current) setPage(result)
    } catch (error) {
      if (alive.current) setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [api, query, sort])

  const loadInstalled = useCallback(async () => {
    try {
      const items = await api.installed()
      if (alive.current) setInstalled(items)
    } catch {
      // Failing to read the installed list must not stop catalog browsing — leave it empty.
    }
  }, [api])

  useEffect(() => { void loadCatalog() }, [loadCatalog])
  useEffect(() => { void loadInstalled() }, [loadInstalled])

  useEffect(() => {
    if (tab !== 'diagnostics') return
    setDiagnostics(undefined)
    void api.diagnostics().then((data) => { if (alive.current) setDiagnostics(data) })
  }, [api, tab])

  const setState = useCallback((key: string, next: CardState) => {
    setStates(prev => new Map(prev).set(key, next))
  }, [])

  /** Run one install or uninstall, reducing progress events into that card's state. */
  const runAction = useCallback(async (
    key: string,
    verb: CardVerb,
    action: (onEvent: (event: Parameters<typeof reduce>[1]) => void) => Promise<void>,
  ) => {
    // Held in an object rather than a bare let: the state advances inside callbacks, and a bare variable would be narrowed to the initial working.
    const box: { state: CardState } = { state: { kind: 'working', verb, log: [] } }
    setState(key, box.state)
    await action((event) => {
      box.state = reduce(box.state, event, verb)
      if (alive.current) setState(key, box.state)
    })
    if (box.state.kind === 'done') void loadInstalled()
  }, [loadInstalled, setState])

  const onInstall = useCallback((entry: SkinEntry) => {
    void runAction(cardKeyOf(entry), 'install', onEvent => api.install(entry.installSpec ?? '', onEvent))
  }, [api, runAction])

  const onAllowBuilds = useCallback((entry: SkinEntry) => {
    void runAction(cardKeyOf(entry), 'install', onEvent => api.allowBuilds(entry.installSpec ?? '', onEvent))
  }, [api, runAction])

  // Uninstall needs the real package name, looked up from the installed list by spec — the card itself does not know it.
  const onUninstallEntry = useCallback((entry: SkinEntry) => {
    const match = installed.find(row => row.spec === entry.installSpec)
    if (match === undefined) return
    void runAction(cardKeyOf(entry), 'uninstall', onEvent => api.uninstall(match.packageName, onEvent))
  }, [api, installed, runAction])

  const onUninstallName = useCallback((packageName: string) => {
    void runAction(packageName, 'uninstall', onEvent => api.uninstall(packageName, onEvent))
  }, [api, runAction])

  const onDismiss = useCallback((entry: SkinEntry) => {
    setState(cardKeyOf(entry), IDLE)
  }, [setState])

  // Decide "is this installed" by spec: the spec is the only stable correspondence between the registry and this machine.
  const installedSpecs = useMemo(
    () => new Set(installed.map(item => item.spec).filter((spec): spec is string => spec !== undefined)),
    [installed],
  )

  const items = page?.items ?? []
  const total = page?.total ?? 0

  return (
    <section className={styles.root}>
      <div className={styles.head}>
        <h2 className={styles.title}>{t('nav')}</h2>
        <span className={styles.version}>v{version}</span>
      </div>
      <p className={styles.subtitle}>
        {t('subtitle')} · <span className={styles.count}>{total}</span> · {t('source.live')}
      </p>

      {page?.staleReason !== undefined && <div className={styles.stale}>{page.staleReason}</div>}

      <div className={styles.tabs} role="tablist">
        {(['discover', 'installed', 'diagnostics'] as const).map(key => (
          <button
            key={key}
            className={styles.tab}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => { setTab(key) }}
          >
            {t(`tab.${key}`)}{key === 'installed' && installed.length > 0 ? ` (${installed.length})` : ''}
          </button>
        ))}
      </div>

      {tab === 'discover' && (
        <>
          <div className={styles.search}>
            <span aria-hidden="true">🔍</span>
            <input
              type="search"
              value={term}
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              onChange={(event) => { setTerm(event.target.value) }}
            />
            <span className={styles.hits}>{t('search.hits', { shown: items.length, total })}</span>
          </div>

          <div className={styles.sortbar}>
            {SORTS.map(option => (
              <button
                key={option.key}
                className={styles.sort}
                type="button"
                aria-pressed={sort === option.key}
                onClick={() => { setSort(option.key) }}
              >
                {t(option.label)}
              </button>
            ))}
          </div>

          <div className={styles.list}>
            {loading && items.length === 0 && <div className={styles.empty}>{t('state.loading')}</div>}

            {failure !== undefined && (
              <div className={styles.empty}>
                {t('state.failed')}
                <div className={styles.emptyHint}>{failure}</div>
                <div className={styles.errorActions}>
                  <button className={styles.ghost} type="button" onClick={() => { void loadCatalog() }}>
                    {t('state.retry')}
                  </button>
                </div>
              </div>
            )}

            {!loading && failure === undefined && items.length === 0 && (
              <div className={styles.empty}>
                {query === '' ? t('empty.none') : t('empty.search', { term: query })}
                <div className={styles.emptyHint}>
                  {query === '' ? t('empty.noneHint') : t('empty.searchHint')}
                </div>
              </div>
            )}

            {items.map(entry => (
              <SkinCard
                key={`${entry.skinId}:${entry.variant ?? ''}`}
                entry={entry}
                installed={entry.installSpec !== undefined && installedSpecs.has(entry.installSpec)}
                state={states.get(cardKeyOf(entry)) ?? IDLE}
                t={t}
                onInstall={onInstall}
                onUninstall={onUninstallEntry}
                onAllowBuilds={onAllowBuilds}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        </>
      )}

      {tab === 'installed' && (
        <>
          {/*
            The appearance row lists only dsh's own three (follow system / light / dark).
            Third-party skins are switched from the Installed tab instead — once there are many,
            this row would burst with a line of ids that mean nothing to the user.
          */}
          {appearance !== undefined && builtinThemes.length > 0 && (
            <AppearancePicker options={builtinThemes} t={t} onSelect={appearance.select} />
          )}
          <InstalledPanel
            items={installed}
            states={states}
            t={t}
            onUninstall={onUninstallName}
            {...(activeThemeId !== undefined ? { activeThemeId } : {})}
            {...(enableFailure !== undefined ? { failure: enableFailure } : {})}
            onEnable={(id) => {
              /*
               * 🔴 Report the failure; never swallow it.
               *
               * This used to be `appearance?.select(id)` — optional chaining with no catch. When the theme handle
               * was the wrong instance, `setTheme` threw and the whole click became a silent no-op: the button
               * gave no feedback, nothing switched, and nothing was logged. A skin that will not apply is exactly
               * the case the user needs told about.
               */
              setEnableFailure(undefined)
              try {
                appearance?.select(id)
              } catch (error) {
                setEnableFailure(error instanceof Error ? error.message : String(error))
              }
            }}
          />
        </>
      )}

      {tab === 'diagnostics' && (
        <DiagnosticsPanel
          data={diagnostics}
          t={t}
          onRefresh={() => {
            setDiagnostics(undefined)
            void api.diagnostics().then((data) => { if (alive.current) setDiagnostics(data) })
          }}
        />
      )}
    </section>
  )
}
