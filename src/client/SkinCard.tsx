/** One skin card from the catalog: information, a source link, the install button, and in-place feedback for progress and failure. */

import { useState } from 'react'
import type { JSX } from 'react'
import type { SkinEntry } from '../types.ts'
import type { CardState } from './card-state.ts'
import styles from './market.module.css'

/** Card props. */
export interface SkinCardProps {
  readonly entry: SkinEntry
  /** Whether it is installed on this machine. */
  readonly installed: boolean
  /** This card's current install/uninstall state. */
  readonly state: CardState
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly onInstall: (entry: SkinEntry) => void
  readonly onUninstall: (entry: SkinEntry) => void
  /** Fired after the user explicitly consents on the build-script warning. */
  readonly onAllowBuilds: (entry: SkinEntry) => void
  readonly onDismiss: (entry: SkinEntry) => void
}

/**
 * Key for card state. The install spec, not the package name: the real name is known only
 * after installing (`github:LaplaceYoung/dsh-qq2006` installs as
 * `@dsh-external/dsh-qq2006`), and a guessed name neither matches the installed list nor
 * works for uninstalling.
 */
export function cardKeyOf(entry: SkinEntry): string {
  return entry.installSpec ?? entry.skinId
}

/**
 * Source badge: where this skin installs from.
 *
 * On the card rather than only in a tooltip, because a git source and a published artefact
 * differ by an order of magnitude in waiting time (cloning a skin repo with embedded assets
 * takes minutes; fetching a tarball takes seconds). Users deserve to know how long they will
 * wait, and whether consent will be demanded, before they click.
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
 * "Copy install command": the fallback when an automatic install fails.
 *
 * The command differs by source (a short package name, a github: spec, or a long Release asset
 * URL), and the last is too long to retype. So this button is not a nicety — for tarball-sourced
 * skins, copying is very nearly the only way to install manually.
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
     * Outside a secure context `navigator.clipboard` does not exist at all — dsh's default
     * http://127.0.0.1 counts as secure, but binding the webServer to 0.0.0.0 and browsing from
     * another machine on the LAN does not. lib.dom declares it non-nullable, so it is checked
     * explicitly here; otherwise the click does nothing in that case.
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

/** Primary button: one button carries install → installing → refresh to apply / installed → uninstall. */
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
  // Entries with no registered install URL: disable the button and explain, rather than failing after the click.
  if (entry.installSpec === undefined) {
    return (
      <button className={styles.primary} type="button" disabled title={t('card.noSpecHint')}>
        {t('card.noSpec')}
      </button>
    )
  }
  // Wording follows the source: a git source clones then builds, and saying so tells the user to wait rather than retry.
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
 * Render one card.
 * @param props - Entry, state and callbacks.
 * @returns The card element.
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
              Authorising build scripts is the only branch that needs user consent, because consent
              permits that package's code to run locally. Only a git source deserves this escape
              hatch — npm packages and tarballs install published artefacts, so this error means
              the package itself is broken, and offering the button pushes the user the wrong way.
            */}
            {state.code === 'BUILD_SCRIPT_BLOCKED' && entry.installKind === 'github' && (
              <button className={styles.primary} type="button" onClick={() => { onAllowBuilds(entry) }}>
                {t('card.retryAllow')}
              </button>
            )}
            {/*
              Manual installation is the fallback for every failure: in a terminal pnpm has a TTY, so
              progress is visible, and consent is decided on the command line without coming back
              through this UI.
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
