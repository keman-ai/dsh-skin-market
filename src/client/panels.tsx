/** 「已安装」与「诊断」两个 tab 的内容。两者都不依赖集市，断网可用。 */

import type { JSX } from 'react'
import type { Diagnostics, InstalledSkin } from '../types.ts'
import type { AppearanceOption } from './appearance.ts'
import type { CardState } from './card-state.ts'
import styles from './market.module.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** 外观区块入参。 */
export interface AppearancePickerProps {
  readonly options: readonly AppearanceOption[]
  readonly t: Translate
  readonly onSelect: (id: string) => void
}

/** 内置项有本地化名字；皮肤注册的主题按它自己的 id 显示。 */
const BUILTIN_LABEL: Record<string, string> = {
  system: 'appearance.system',
  light: 'appearance.light',
  dark: 'appearance.dark',
}

/** 内置项翻译，皮肤主题原样显示自己的 id。 */
function labelOf(id: string, t: Translate): string {
  const key = BUILTIN_LABEL[id]
  return key === undefined ? id : t(key)
}

/**
 * 外观选择器 —— 皮肤装上之后真正生效的那一步。
 *
 * dsh 自己的外观行只渲染三个内置项，皮肤注册进主题服务后没有界面能选中它。
 * 这里把注册表里的全部主题列出来。
 * @param props - 选项、文案与回调。
 * @returns 区块元素。
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

/** 已安装面板入参。 */
export interface InstalledPanelProps {
  readonly items: readonly InstalledSkin[]
  readonly states: ReadonlyMap<string, CardState>
  readonly t: Translate
  readonly onUninstall: (packageName: string) => void
}

/**
 * 本机已装皮肤。
 * @param props - 列表、状态与回调。
 * @returns 面板元素。
 */
export function InstalledPanel({ items, states, t, onUninstall }: InstalledPanelProps): JSX.Element {
  if (items.length === 0) {
    return (
      <div className={styles.empty}>
        {t('installed.empty')}
        <div className={styles.emptyHint}>{t('installed.emptyHint')}</div>
      </div>
    )
  }

  return (
    <div className={styles.list}>
      {items.map((item) => {
        const state = states.get(item.packageName) ?? { kind: 'idle' as const }
        return (
          <article className={styles.card} key={item.packageName}>
            <div className={styles.icon} aria-hidden="true">◆</div>
            <h3 className={styles.name}>{item.packageName}</h3>
            <p className={styles.meta}>
              {item.version !== undefined && <span>v{item.version}</span>}
              {item.spec !== undefined && <><span>·</span><span>{item.spec}</span></>}
              {item.disabled && <><span>·</span><span>{t('installed.disabled')}</span></>}
            </p>
            <div className={styles.foot}>
              <span className={styles.spacer} />
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
                  <button
                    className={styles.ghost}
                    type="button"
                    disabled={state.kind === 'working'}
                    onClick={() => { onUninstall(item.packageName) }}
                  >
                    {t(state.kind === 'working' ? 'card.uninstalling' : 'card.uninstall')}
                  </button>
                )}
            </div>
            {state.kind === 'working' && state.log.length > 0 && (
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

/** 诊断面板入参。 */
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
 * 环境自查：pnpm、profile、集市连通性、上次安装输出。
 * @param props - 数据与刷新回调。
 * @returns 面板元素。
 */
export function DiagnosticsPanel({ data, t, onRefresh }: DiagnosticsPanelProps): JSX.Element {
  if (data === undefined) return <div className={styles.empty}>{t('diag.loading')}</div>

  return (
    <div className={styles.list}>
      {data.rows.map(row => (
        <div className={styles.diagRow} key={row.key}>
          <span className={styles.diagKey}>{row.key}</span>
          <span className={styles.diagValue}>{row.value}</span>
          <span className={STATUS_CLASS[row.status]}>{row.status === 'ok' ? '正常' : row.status === 'warn' ? '注意' : '异常'}</span>
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
