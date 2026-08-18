/**
 * 皮肤市场的设置页：三个 tab（发现 / 已安装 / 诊断）。
 *
 * 组件只管界面状态；集市地址、缓存、安装白名单都在 host 半。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { CatalogPage, Diagnostics, InstalledSkin, SkinEntry } from '../types.ts'
import type { MarketApi } from './api.ts'
import type { AppearanceOption } from './appearance.ts'
import { IDLE, reduce, type CardState, type CardVerb } from './card-state.ts'
import { SkinCard, cardKeyOf } from './SkinCard.tsx'
import { AppearancePicker, DiagnosticsPanel, InstalledPanel } from './panels.tsx'
import styles from './market.module.css'

/** 由 slot 的 inject 工厂注入的业务面。 */
export interface SkinMarketInjected {
  readonly api: MarketApi
  readonly t: (key: string, params?: Record<string, string | number>) => string
  /** 插件版本，页头展示。 */
  readonly version: string
  /**
   * 外观面。宿主组合里没有 ui-theme 时为 undefined —— 那时市场只管装，
   * 不管应用（外观区块整个不渲染）。
   */
  readonly appearance?: {
    readonly options: () => readonly AppearanceOption[]
    readonly subscribe: (listener: () => void) => () => void
    readonly select: (id: string) => void
  }
}

type Tab = 'discover' | 'installed' | 'diagnostics'

/** 搜索防抖：边打字边打服务端会把上游打满，也会让列表抖。 */
const SEARCH_DEBOUNCE_MS = 350

/** 取值由集市定义，不是我们自己起的名字：popular / latest / name。 */
const SORTS = [
  { key: 'popular', label: 'sort.popular' },
  { key: 'latest', label: 'sort.latest' },
  { key: 'name', label: 'sort.name' },
] as const

/**
 * 市场页。
 * @param props - 注入的业务面。
 * @returns 页面元素。
 */
export function SkinMarketSection({ api, t, version, appearance }: SkinMarketInjected): JSX.Element {
  const [tab, setTab] = useState<Tab>('discover')
  const [term, setTerm] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<string>('popular')
  const [page, setPage] = useState<CatalogPage | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [installed, setInstalled] = useState<readonly InstalledSkin[]>([])
  const [diagnostics, setDiagnostics] = useState<Diagnostics | undefined>(undefined)
  const [states, setStates] = useState<ReadonlyMap<string, CardState>>(new Map())
  const [themes, setThemes] = useState<readonly AppearanceOption[]>(() => appearance?.options() ?? [])

  // 皮肤的 bundle 是异步加载的，主题会在页面起来之后才注册进来。
  useEffect(() => {
    if (appearance === undefined) return
    setThemes(appearance.options())
    return appearance.subscribe(() => { setThemes(appearance.options()) })
  }, [appearance])

  // 卸载后仍可能有事件回来，用它挡住对已卸组件的 setState。
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
      // 已装列表拿不到不该影响浏览目录，留空即可。
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

  /** 跑一次装/卸，把过程事件归约进那张卡的状态。 */
  const runAction = useCallback(async (
    key: string,
    verb: CardVerb,
    action: (onEvent: (event: Parameters<typeof reduce>[1]) => void) => Promise<void>,
  ) => {
    // 装在对象里而不是裸 let：状态是在回调里推进的，裸变量会被窄化成初始的 working。
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

  // 卸载要的是真实包名，从已装列表里按 spec 反查 —— 卡片自己并不知道它。
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

  // 按 spec 判断"这条装没装"：spec 是集市与本机之间唯一稳定的对应关系。
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
          {appearance !== undefined && themes.length > 0 && (
            <AppearancePicker options={themes} t={t} onSelect={appearance.select} />
          )}
          <InstalledPanel items={installed} states={states} t={t} onUninstall={onUninstallName} />
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
