/**
 * Browser-side market client: same-origin calls to the host half's routes.
 *
 * The registry URL, caching and allowlist all live on the host side; this only hands results to the UI.
 */

import type { CatalogPage, Diagnostics, InstallEvent, InstalledSkin } from '../types.ts'

/** Kept in sync with the host half's API_PREFIX. */
const PREFIX = '/skin-market/api'

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${PREFIX}${path}`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as T
}

/** Every backend action the UI uses. */
export interface MarketApi {
  catalog(query: { q: string; sort: string; page: number }): Promise<CatalogPage>
  installed(): Promise<readonly InstalledSkin[]>
  diagnostics(): Promise<Diagnostics>
  /** Install a package, reporting progress events one by one. The real package name is read from the install result by the host and returned with the done event. */
  install(spec: string, onEvent: (event: InstallEvent) => void): Promise<void>
  uninstall(packageName: string, onEvent: (event: InstallEvent) => void): Promise<void>
  /** After explicit user consent: authorise build scripts and retry the install. */
  allowBuilds(spec: string, onEvent: (event: InstallEvent) => void): Promise<void>
}

/**
 * Consume an SSE stream, parsing `data:` lines into events for the caller.
 *
 * Hand-written rather than EventSource because this is a POST with a body; EventSource is GET-only.
 */
async function stream(
  path: string, body: unknown, onEvent: (event: InstallEvent) => void,
): Promise<void> {
  const response = await fetch(`${PREFIX}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  // Auth failures return JSON before the stream opens; treat those as ordinary errors.
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('event-stream')) {
    const payload = await response.json().catch(() => ({})) as { code?: string; message?: string }
    onEvent({
      type: 'error',
      code: (payload.code as InstallEvent extends { code: infer C } ? C : never) ?? 'PNPM_FAILED',
      message: payload.message ?? `HTTP ${response.status}`,
    })
    return
  }

  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('response has no readable stream')
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE separates events with blank lines; the last piece may be partial, so it waits in the buffer.
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find(row => row.startsWith('data:'))
      if (line === undefined) continue
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as InstallEvent)
      } catch {
        // Half an event must not abort the whole install — drop it and keep reading.
      }
    }
  }
}

/** Create a market client. */
export function createApi(): MarketApi {
  return {
    catalog: async ({ q, sort, page }) => {
      const params = new URLSearchParams({ page: String(page), size: '24' })
      if (q !== '') params.set('q', q)
      if (sort !== '') params.set('sort', sort)
      return await getJson<CatalogPage>(`/catalog?${params.toString()}`)
    },
    installed: async () => (await getJson<{ items: InstalledSkin[] }>('/installed')).items,
    diagnostics: async () => await getJson<Diagnostics>('/diagnostics'),
    install: async (spec, onEvent) => { await stream('/install', { spec }, onEvent) },
    uninstall: async (packageName, onEvent) => { await stream('/uninstall', { packageName }, onEvent) },
    allowBuilds: async (spec, onEvent) => { await stream('/allow-builds', { spec }, onEvent) },
  }
}
