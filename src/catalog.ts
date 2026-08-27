/**
 * The registry catalog: fetch upstream, normalise, cache, and fall back when offline.
 *
 * Proxying through the host half instead of letting the browser reach the registry directly
 * buys four things: no CORS to add on the registry gateway, cacheable results, a bundled
 * snapshot to fall back on when unreachable, and no third-party connection from a remote browser.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { classifySpec, installCommandFor } from './spec.ts'
import type { CatalogPage, SkinEntry } from './types.ts'

/**
 * Registry URL. **The `/dsh-skin` context path is mandatory** — without it CloudFront falls
 * the request back to the SPA and returns 200 with index.html instead of 404, which is deeply
 * misleading to debug.
 */
export const DEFAULT_CATALOG_ORIGIN = 'https://dsh.a2hmarket.ai/dsh-skin'

/** Catalog TTL. The skin catalog changes slowly; ten minutes is plenty and keeps paging off upstream. */
const CACHE_TTL_MS = 10 * 60 * 1000

/** Upstream timeout. Better to fall back to cache quickly than leave the settings page spinning. */
const UPSTREAM_TIMEOUT_MS = 8000

/**
 * Popularity-report timeout, half the catalog's: it is optional telemetry, and there is no
 * reason to wait longer for a response we can do without.
 */
const REPORT_TIMEOUT_MS = 4000

/** Maximum entries per page. More from upstream is truncated, so we never render a thousand cards at once. */
const MAX_PAGE_SIZE = 60

/** findu's uniform response envelope. Business failures also return HTTP 200, so the code must be checked. */
interface ApiEnvelope<T> {
  readonly code?: string
  readonly message?: string
  readonly data?: T
}

interface UpstreamPage {
  readonly items?: readonly unknown[]
  readonly total?: number
  readonly page?: number
  readonly size?: number
}

/** A catalog query. Fields are explicitly undefined-able so the route layer can pass parsed results straight through without conditional spreading. */
export interface CatalogQuery {
  /** Search term, passed through as the registry's keyword parameter. */
  readonly q?: string | undefined
  /** Sort order as defined by the registry: popular / name / latest. */
  readonly sort?: string | undefined
  /** Tag filter, passed through as the registry's tag parameter. */
  readonly tag?: string | undefined
  readonly page?: number | undefined
  readonly size?: number | undefined
}

interface CacheRow {
  readonly at: number
  readonly page: CatalogPage
}

const str = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * Derive `github:owner/repo` from a repository URL, as the install spec when there is no npm name.
 *
 * 🔴 <b>Only URLs pointing exactly at a repository root count.</b> A path segment after
 * owner/repo means this repoUrl points somewhere inside the repository — and once a monorepo
 * gathers many skins, `github.com/org/skins/tree/main/packages/niulai` is the norm.
 *
 * pnpm has no notion of installing from a subdirectory of a git repo, so a forced
 * `github:org/skins` installs the entire monorepo as one package, makes the user wait through
 * a clone, and then rolls back at mount with NOT_A_BUNDLE. Such entries should be marked
 * uninstallable from the start, so the author supplies a real installSpec (an npm name or a
 * Release tarball).
 *
 * @param repoUrl - The repository URL registered with the registry.
 * @returns The install spec, or undefined when the URL is not a repository root.
 */
function githubSpecOf(repoUrl: string | undefined): string | undefined {
  if (repoUrl === undefined) return undefined
  let url: URL
  try {
    url = new URL(repoUrl)
  } catch {
    return undefined
  }
  if (url.hostname !== 'github.com') return undefined
  const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (segments.length !== 2) return undefined
  const owner = segments[0]
  const repo = segments[1]?.replace(/\.git$/, '')
  if (owner === undefined || owner === '' || repo === undefined || repo === '') return undefined
  return `github:${owner}/${repo}`
}

/** Normalise a date to YYYY-MM-DD; whatever format upstream sends must not break a card. */
function dateOf(value: unknown): string | undefined {
  const raw = str(value)
  if (raw === undefined) return undefined
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? raw.slice(0, 10) : parsed.toISOString().slice(0, 10)
}

/** Upstream cover: prefer an explicit iconUrl, otherwise take the cover from media. */
function iconOf(row: Record<string, unknown>): string | undefined {
  const direct = str(row.iconUrl) ?? str(row.coverUrl)
  if (direct !== undefined) return direct
  const media = Array.isArray(row.media) ? row.media : []
  for (const item of media) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (str(entry.kind)?.toUpperCase() === 'COVER') return str(entry.url)
  }
  return undefined
}

/**
 * Author name. The registry currently sends `authorNickname`; the other two shapes (string /
 * object) leave room for a future API consolidation, and all three are accepted.
 */
function authorOf(row: Record<string, unknown>): { name: string; url?: string } {
  const nickname = str(row.authorNickname)
  if (nickname !== undefined) return { name: nickname }
  const raw = row.author
  if (typeof raw === 'object' && raw !== null) {
    const entry = raw as Record<string, unknown>
    return { name: str(entry.name) ?? 'anonymous', ...(str(entry.homepage) !== undefined ? { url: str(entry.homepage)! } : {}) }
  }
  return { name: str(raw) ?? str(row.authorName) ?? 'anonymous' }
}

/** Tags: the registry sends an array, while an earlier field was a comma-separated string. Both are accepted. */
function tagsOf(row: Record<string, unknown>): readonly string[] {
  if (Array.isArray(row.tags)) {
    return row.tags.map(str).filter((tag): tag is string => tag !== undefined)
  }
  return (str(row.tags) ?? '').split(',').map(tag => tag.trim()).filter(tag => tag !== '')
}

/**
 * Extract the spec from the full install command the registry provides.
 *
 * It looks like `dsh plugin --profile web add -w github:owner/repo`. Scan backwards for the
 * first word that is not a flag — the spec is always last, and `add` may be followed first by
 * `-w` (a required flag: the profile directory ships a pnpm-workspace.yaml, and without it
 * pnpm refuses).
 */
function specFromCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined
  const words = command.trim().split(/\s+/)
  const at = words.lastIndexOf('add')
  if (at < 0) return undefined
  for (let index = words.length - 1; index > at; index -= 1) {
    const word = words[index]
    if (word === undefined || word.startsWith('-')) continue
    // A placeholder-style command (`add <path to clone>`) is not a directly installable spec.
    return word.startsWith('<') ? undefined : word
  }
  return undefined
}

/**
 * One upstream row → one catalog entry.
 * Every missing field has a fallback; one incomplete record must never take down a whole page.
 * @param raw - One item from the upstream items array.
 * @returns The normalised entry, or undefined when even the id is missing (that row is dropped).
 */
export function normalizeEntry(raw: unknown): SkinEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const skinId = str(row.skinId) ?? str(row.id)
  const slug = str(row.slug) ?? str(row.packageName) ?? skinId
  if (skinId === undefined || slug === undefined) return undefined

  const author = authorOf(row)
  const repoUrl = str(row.repoUrl)
  // Priority: explicit spec → the registry's full install command → npm package name → derived from the repo URL.
  //
  // Ranking installCommand above packageName was learned the hard way: a live skin filled
  // packageName with a harness package (`@deepseek-ai/dsh-client-ui-conversation`, probably
  // meaning "I override this"), while the same row's installCommand was correct. An install
  // command is written for a human to type, so the author notices their own mistake;
  // packageName is just an unverified metadata field.
  //
  // Classification and safety checks all live in classifySpec: unrecognised, a host outside the
  // allowlist, a monorepo subdirectory, or a harness package all return undefined, making the
  // entry browsable but not installable.
  const resolved = classifySpec(str(row.installSpec)
    ?? specFromCommand(str(row.installCommand))
    ?? str(row.packageName)
    ?? githubSpecOf(repoUrl))
  const variant = str(row.variant)
  const icon = iconOf(row)
  const category = str(row.category) ?? tagsOf(row)[0]
  const releasedAt = dateOf(row.releasedAt ?? row.updatedAt)

  return {
    skinId,
    slug,
    ...(variant !== undefined ? { variant } : {}),
    name: str(row.name) ?? slug,
    ...(str(row.tagline) !== undefined ? { tagline: str(row.tagline)! } : {}),
    author: author.name,
    ...(author.url !== undefined ? { authorUrl: author.url } : {}),
    ...(icon !== undefined ? { iconUrl: icon } : {}),
    ...(category !== undefined ? { category } : {}),
    starCount: num(row.starCount ?? row.stars),
    ...(releasedAt !== undefined ? { releasedAt } : {}),
    ...(repoUrl !== undefined ? { repoUrl } : {}),
    ...(resolved !== undefined
      ? {
        installSpec: resolved.spec,
        installKind: resolved.kind,
        installCommand: installCommandFor(resolved.spec),
      }
      : {}),
    installCount: num(row.installCount),
  }
}

/** Catalog service: one instance per dsh process. */
export class Catalog {
  private readonly origin: string
  private readonly cache = new Map<string, CacheRow>()
  private snapshot: readonly SkinEntry[] | undefined

  /**
   * @param origin - The registry root URL, including the context path.
   */
  constructor(origin: string = DEFAULT_CATALOG_ORIGIN) {
    this.origin = origin.replace(/\/+$/, '')
  }

  /**
   * Fetch one catalog page. When upstream is unavailable it falls back to the cache, then the
   * bundled snapshot, and states the source in the result — so the user knows the data is old
   * rather than being shown a pretence of being online.
   * @param query - Search term, sort and pagination.
   * @returns One catalog page. Never throws.
   */
  async page(query: CatalogQuery): Promise<CatalogPage> {
    const size = Math.min(Math.max(query.size ?? 24, 1), MAX_PAGE_SIZE)
    const page = Math.max(query.page ?? 1, 1)
    const key = JSON.stringify([query.q ?? '', query.sort ?? '', query.tag ?? '', page, size])

    const cached = this.cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.page
    }

    try {
      const live = await this.fetchPage({ ...query, page, size })
      this.cache.set(key, { at: Date.now(), page: live })
      return live
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (cached !== undefined) {
        return { ...cached.page, source: 'cache', staleReason: `registry unreachable (${reason}); showing the local cache` }
      }
      return this.fromSnapshot(query, page, size, reason)
    }
  }

  /**
   * The catalog entry matching this install spec.
   *
   * This is both the pre-install allowlist check (no arbitrary package names) and a way to hand
   * back the entry itself — its skinId reports popularity after installing, so the client never
   * has to send an id it could fabricate.
   *
   * @param spec - The install spec to validate.
   * @returns The matching entry, or undefined when it is not in the catalog.
   */
  async findBySpec(spec: string): Promise<SkinEntry | undefined> {
    let scanned = 0
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.page({ page, size: MAX_PAGE_SIZE })
      for (const item of result.items) {
        if (item.installSpec === spec) return item
      }
      // Decide "reached the end" from entries scanned, not specs collected: entries with no
      // installSpec (incomplete metadata, uninstallable) still count towards total, so comparing
      // against a deduplicated spec count always falls short and needlessly walks all ten pages.
      scanned += result.items.length
      if (result.items.length === 0 || scanned >= result.total) break
    }
    return undefined
  }

  /** Is this install spec in the catalog — the pre-install allowlist check that blocks arbitrary package names. */
  async allows(spec: string): Promise<boolean> {
    return await this.findBySpec(spec) !== undefined
  }

  /**
   * Report one popularity hit to the registry after a successful install.
   *
   * 🔴 <b>Never affects the install result.</b> A dead registry, a timeout or a business error
   * are all swallowed. The user's skin is already installed, and turning success into failure
   * over a telemetry ping has it backwards — callers should not await this either.
   *
   * @param skinId - The registry entry id.
   * @returns Whether it was actually recorded, for tests and diagnostics.
   */
  async reportInstall(skinId: string): Promise<boolean> {
    const url = `${this.origin}/api/v1/public/skins/${encodeURIComponent(skinId)}/install-hit`
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
      if (!response.ok) return false
      // As in fetchPage: findu's envelope returns 200 on business failure too, so status alone would read failure as success.
      const envelope = await response.json() as ApiEnvelope<unknown>
      return envelope.code === undefined || envelope.code === 'OK'
    } catch {
      return false
    }
  }

  private async fetchPage(
    query: CatalogQuery & { readonly page: number; readonly size: number },
  ): Promise<CatalogPage> {
    const url = new URL(`${this.origin}/api/v1/public/skins`)
    url.searchParams.set('page', String(query.page))
    url.searchParams.set('size', String(query.size))
    // The registry's search parameter is keyword (server-side LIKE + pagination), not q — the wrong name means no search at all.
    if (query.q !== undefined && query.q !== '') url.searchParams.set('keyword', query.q)
    // Valid sort values are defined by the registry: popular / name / latest (the default).
    if (query.sort !== undefined && query.sort !== '') url.searchParams.set('sort', query.sort)
    if (query.tag !== undefined && query.tag !== '') url.searchParams.set('tag', query.tag)

    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    // Without the context path CloudFront returns index.html — catch it here via content-type,
    // or the JSON parse below throws an error unrelated to the actual cause.
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      throw new Error(`upstream returned ${contentType || 'an unknown type'} instead of JSON — check whether the /dsh-skin prefix is missing from the URL`)
    }

    const envelope = await response.json() as ApiEnvelope<UpstreamPage>
    // findu's ApiResponse returns 200 on business failure too, so status alone would read an error as an empty list.
    if (envelope.code !== undefined && envelope.code !== 'OK') {
      throw new Error(`registry returned ${envelope.code}: ${envelope.message ?? 'no reason given'}`)
    }

    const data = envelope.data ?? {}
    const items = (data.items ?? [])
      .map(normalizeEntry)
      .filter((entry): entry is SkinEntry => entry !== undefined)

    return {
      items,
      total: typeof data.total === 'number' ? data.total : items.length,
      page: query.page,
      size: query.size,
      source: 'live',
    }
  }

  /** Bundled snapshot: the last resort when the registry has never been reachable. */
  private async fromSnapshot(
    query: CatalogQuery, page: number, size: number, reason: string,
  ): Promise<CatalogPage> {
    if (this.snapshot === undefined) {
      try {
        const file = fileURLToPath(new URL('../snapshot/skins.json', import.meta.url))
        const parsed = JSON.parse(await readFile(file, 'utf8')) as { items?: readonly unknown[] }
        this.snapshot = (parsed.items ?? [])
          .map(normalizeEntry)
          .filter((entry): entry is SkinEntry => entry !== undefined)
      } catch {
        this.snapshot = []
      }
    }
    const term = (query.q ?? '').toLowerCase()
    const matched = term === ''
      ? this.snapshot
      : this.snapshot.filter(entry => `${entry.slug} ${entry.name} ${entry.author} ${entry.tagline ?? ''}`
        .toLowerCase().includes(term))
    return {
      items: matched.slice((page - 1) * size, page * size),
      total: matched.length,
      page,
      size,
      source: 'snapshot',
      staleReason: `registry unreachable (${reason}); showing the snapshot bundled with the plugin`,
    }
  }
}
