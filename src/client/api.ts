/**
 * 浏览器侧的市场客户端：同源调 host 半的路由。
 *
 * 集市地址、缓存、白名单都在 host 那边，这里只关心把结果交给界面。
 */

import type { CatalogPage, Diagnostics, InstallEvent, InstalledSkin } from '../types.ts'

/** 与 host 半的 API_PREFIX 保持一致。 */
const PREFIX = '/skin-market/api'

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${PREFIX}${path}`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as T
}

/** 界面用到的全部后端动作。 */
export interface MarketApi {
  catalog(query: { q: string; sort: string; page: number }): Promise<CatalogPage>
  installed(): Promise<readonly InstalledSkin[]>
  diagnostics(): Promise<Diagnostics>
  /** 装一个包，过程事件逐条回调。真实包名由 host 从安装结果读出，随 done 事件回来。 */
  install(spec: string, onEvent: (event: InstallEvent) => void): Promise<void>
  uninstall(packageName: string, onEvent: (event: InstallEvent) => void): Promise<void>
  /** 用户明确同意后：授权构建脚本并重试安装。 */
  allowBuilds(spec: string, onEvent: (event: InstallEvent) => void): Promise<void>
}

/**
 * 消费一条 SSE：把 `data:` 行解析成事件推给调用方。
 *
 * 手写而不用 EventSource，因为这是 POST 且要带 body；EventSource 只能 GET。
 */
async function stream(
  path: string, body: unknown, onEvent: (event: InstallEvent) => void,
): Promise<void> {
  const response = await fetch(`${PREFIX}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  // 鉴权类失败在开流之前就回了 JSON，这时按普通错误处理。
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
  if (reader === undefined) throw new Error('响应没有可读流')
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE 以空行分隔事件；最后一段可能不完整，留在 buffer 里等下一块。
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find(row => row.startsWith('data:'))
      if (line === undefined) continue
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as InstallEvent)
      } catch {
        // 半条事件不该打断整个安装过程，丢掉继续读。
      }
    }
  }
}

/** 建一个市场客户端。 */
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
