/** 目录里的一张皮肤卡片：信息、源码入口、安装按钮，以及安装过程与失败的原地反馈。 */

import { useState } from 'react'
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

/**
 * 卡片状态的键。用安装 spec 而不是包名：真实包名要装完才知道
 * （`github:LaplaceYoung/dsh-qq2006` 装出来叫 `@dsh-external/dsh-qq2006`），
 * 猜出来的名字既对不上已装列表，也没法用来卸载。
 */
export function cardKeyOf(entry: SkinEntry): string {
  return entry.installSpec ?? entry.skinId
}

/**
 * 来源徽章：这条皮肤是从哪儿装的。
 *
 * 放在卡片上而不是只放在提示里，是因为 git 源和发布物的等待时间差着一个数量级
 * （clone 一个内嵌素材的皮肤仓要几分钟，拉一个 tarball 是几秒），
 * 用户有权在点下去之前就知道自己要等多久、会不会被要求授权。
 */
function sourceBadge(entry: SkinEntry, t: SkinCardProps['t']): JSX.Element | false {
  if (entry.installKind === undefined) return false
  return (
    <span
      className={`${styles.tag} ${styles.kind}`}
      title={t(`kind.${entry.installKind}.hint`)}
    >
      {t(`kind.${entry.installKind}`)}
    </span>
  )
}

/**
 * 「复制安装命令」：自动安装失败之后的兜底出口。
 *
 * 命令按来源各不相同（一个短包名、一条 github: spec、或一串 Release 附件 URL），
 * 后者长到没法照着敲，所以这颗按钮不是锦上添花 —— tarball 来源的皮肤，
 * 手动安装几乎只能靠复制。
 */
function CopyCommandButton(
  { entry, t }: { readonly entry: SkinEntry; readonly t: SkinCardProps['t'] },
): JSX.Element | false {
  const [copied, setCopied] = useState(false)
  const command = entry.installCommand
  if (command === undefined) return false

  const fallback = (): void => { window.prompt(t('card.copyFallback'), command) }

  const copy = (): void => {
    /*
     * 非安全上下文下 `navigator.clipboard` 整个不存在 —— dsh 默认跑在
     * http://127.0.0.1 上算安全上下文，但用户把 webServer 绑到 0.0.0.0
     * 再从局域网另一台机器访问时就不是了。lib.dom 把它声明成非空，
     * 所以这里显式收一次，否则那种场景下点击毫无反应。
     */
    const clipboard = navigator.clipboard as Clipboard | undefined
    if (clipboard === undefined) return fallback()
    void clipboard.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 2000)
    }).catch(fallback)
  }

  return (
    <button className={styles.ghost} type="button" onClick={copy} title={command}>
      {t(copied ? 'card.copied' : 'card.copyCommand')}
    </button>
  )
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
  // 按来源换提示语：git 源要 clone 再构建，说清楚了用户才知道该等而不是该重试。
  const hint = entry.installKind === undefined ? undefined : t(`kind.${entry.installKind}.hint`)
  return (
    <button
      className={styles.primary}
      type="button"
      onClick={() => { onInstall(entry) }}
      {...(hint !== undefined ? { title: hint } : {})}
    >
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
        {sourceBadge(entry, t)}
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
            {/*
              构建脚本授权是唯一需要用户点头的分支：点头等于允许该包代码在本机执行。
              只有 git 源配得上这个出口 —— npm 包和 tarball 装的是发布物，
              它们报这个错是包自己有毛病，给授权按钮等于把用户往错误的方向推。
            */}
            {state.code === 'BUILD_SCRIPT_BLOCKED' && entry.installKind === 'github' && (
              <button className={styles.primary} type="button" onClick={() => { onAllowBuilds(entry) }}>
                {t('card.retryAllow')}
              </button>
            )}
            {/*
              手动安装是所有失败的兜底出口：终端里 pnpm 有 TTY，进度看得见，
              授权与否也由用户自己在命令行上决定，不必绕回这个界面。
            */}
            <CopyCommandButton entry={entry} t={t} />
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
