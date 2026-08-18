/** 目录里的一张皮肤卡片：信息、源码入口、安装按钮，以及安装过程与失败的原地反馈。 */

import type { JSX } from 'react'
import type { SkinEntry } from '../types.ts'
import type { CardState } from './card-state.ts'
import styles from './market.module.css'

/** 卡片入参。 */
export interface SkinCardProps {
  readonly entry: SkinEntry
  /** 本机是否已装。 */
  readonly installed: boolean
  /** 这张卡当前的安装/卸载状态。 */
  readonly state: CardState
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly onInstall: (entry: SkinEntry) => void
  readonly onUninstall: (entry: SkinEntry) => void
  /** 用户在构建脚本告警上明确同意后触发。 */
  readonly onAllowBuilds: (entry: SkinEntry) => void
  readonly onDismiss: (entry: SkinEntry) => void
}

/** 从安装 spec 推包名，与 host 半保持同一套规则。 */
export function packageNameOf(entry: SkinEntry): string {
  const spec = entry.installSpec ?? ''
  if (spec === '') return entry.slug
  if (!spec.startsWith('github:')) return spec
  return spec.replace(/^github:/, '').split('/').pop()?.split('#')[0] ?? entry.slug
}

/** 主按钮：一个按钮走完 安装 → 安装中 → 刷新生效 / 已装 → 卸载。 */
function actionButton(props: SkinCardProps): JSX.Element {
  const { entry, installed, state, t, onInstall, onUninstall } = props

  if (state.kind === 'working') {
    return (
      <button className={styles.primary} type="button" disabled>
        {t(state.verb === 'install' ? 'card.installing' : 'card.uninstalling')}
      </button>
    )
  }
  if (state.kind === 'done') {
    return (
      <button
        className={`${styles.primary} ${styles.done}`}
        type="button"
        onClick={() => { window.location.reload() }}
      >
        {t('card.reload')}
      </button>
    )
  }
  if (installed) {
    return (
      <button className={styles.ghost} type="button" onClick={() => { onUninstall(entry) }}>
        {t('card.uninstall')}
      </button>
    )
  }
  // 目录里没登记安装地址的条目：按钮直接禁用并说明，而不是点了才失败。
  if (entry.installSpec === undefined) {
    return (
      <button className={styles.primary} type="button" disabled title={t('card.noSpecHint')}>
        {t('card.noSpec')}
      </button>
    )
  }
  return (
    <button className={styles.primary} type="button" onClick={() => { onInstall(entry) }}>
      {t('card.install')}
    </button>
  )
}

/**
 * 渲染一张卡片。
 * @param props - 条目、状态与回调。
 * @returns 卡片元素。
 */
export function SkinCard(props: SkinCardProps): JSX.Element {
  const { entry, state, t, onAllowBuilds, onDismiss } = props
  const title = entry.variant === undefined
    ? entry.slug
    : <>{entry.slug}<span className={styles.variant}>#{entry.variant}</span></>

  return (
    <article className={styles.card}>
      {entry.iconUrl === undefined
        ? <div className={styles.icon} aria-hidden="true">◆</div>
        : <img className={styles.icon} src={entry.iconUrl} alt="" loading="lazy" />}

      <h3 className={styles.name}>{title}</h3>
      <p className={styles.meta}>
        <span>{entry.author}</span>
        {entry.starCount > 0 && <><span>·</span><span className={styles.star}>★ {entry.starCount}</span></>}
        {entry.releasedAt !== undefined && <><span>·</span><span>{entry.releasedAt}</span></>}
      </p>

      {entry.tagline !== undefined && <p className={styles.desc}>{entry.tagline}</p>}

      <div className={styles.foot}>
        {entry.category !== undefined && <span className={styles.tag}>{entry.category}</span>}
        <span className={styles.spacer} />
        {entry.repoUrl !== undefined && (
          <a className={styles.ghost} href={entry.repoUrl} target="_blank" rel="noreferrer noopener">
            # {t('card.source')}
          </a>
        )}
        {actionButton(props)}
      </div>

      {state.kind === 'working' && state.log.length > 0 && (
        <pre className={styles.log}>{state.log.join('\n')}</pre>
      )}

      {state.kind === 'error' && (
        <div className={styles.error}>
          <div className={styles.errorTitle}>{state.message}</div>
          {state.detail !== undefined && <div>{state.detail}</div>}
          <div className={styles.errorActions}>
            {/* 构建脚本授权是唯一需要用户点头的分支：点头等于允许该包代码在本机执行。 */}
            {state.code === 'BUILD_SCRIPT_BLOCKED' && entry.installSpec !== undefined && (
              <button className={styles.primary} type="button" onClick={() => { onAllowBuilds(entry) }}>
                {t('card.retryAllow')}
              </button>
            )}
            <button className={styles.ghost} type="button" onClick={() => { onDismiss(entry) }}>
              {t('card.dismiss')}
            </button>
          </div>
          {state.log.length > 0 && <pre className={styles.log}>{state.log.join('\n')}</pre>}
        </div>
      )}
    </article>
  )
}
