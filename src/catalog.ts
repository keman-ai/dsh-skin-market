/**
 * 集市目录：拉上游、归一化、缓存、断网兜底。
 *
 * 由 host 半代理而不是让浏览器直连集市，换来四件事：不用给集市网关加 CORS、
 * 结果可缓存、连不上时能回落到随包快照、远程浏览器不直连第三方站。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { CatalogPage, SkinEntry } from './types.ts'

/**
 * 集市地址。**必须带 `/dsh-skin` 这个 context-path** —— 少了它 CloudFront 会把
 * 请求回落到 SPA，返回 200 + index.html 而不是 404，排查时极具迷惑性。
 */
export const DEFAULT_CATALOG_ORIGIN = 'https://dsh.a2hmarket.ai/dsh-skin'

/** 目录缓存有效期。皮肤目录变化很慢，10 分钟足够，也让翻页不打上游。 */
const CACHE_TTL_MS = 10 * 60 * 1000

/** 上游超时。宁可快速回落到缓存，也不要让设置页转圈。 */
const UPSTREAM_TIMEOUT_MS = 8000

/**
 * 热度回报超时。比目录短一半：它是可有可无的埋点，
 * 拿不到响应就算了，没有任何理由为它多等。
 */
const REPORT_TIMEOUT_MS = 4000

/** 一页最多几条。上游给更多也截断，避免一次渲染上千张卡片。 */
const MAX_PAGE_SIZE = 60

/** findu 的统一响应信封。业务失败也回 HTTP 200，所以必须验 code。 */
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

/** 目录查询。字段显式带 undefined —— 路由层直接透传解析结果，不必逐个条件展开。 */
export interface CatalogQuery {
  /** 关键词，透传给集市的 keyword 参数。 */
  readonly q?: string | undefined
  /** 集市定义的排序：popular / name / latest。 */
  readonly sort?: string | undefined
  /** 标签筛选，透传给集市的 tag 参数。 */
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

/** 从仓库地址推 `github:owner/repo`，作为没有 npm 包名时的安装 spec。 */
function githubSpecOf(repoUrl: string | undefined): string | undefined {
  if (repoUrl === undefined) return undefined
  const match = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(repoUrl)
  return match === null ? undefined : `github:${match[1]}/${match[2]}`
}

/** 日期归一到 YYYY-MM-DD；上游给什么格式都不让它把卡片弄崩。 */
function dateOf(value: unknown): string | undefined {
  const raw = str(value)
  if (raw === undefined) return undefined
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? raw.slice(0, 10) : parsed.toISOString().slice(0, 10)
}

/** 上游封面：优先显式 iconUrl，退而求其次取 media 里的封面。 */
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
 * 作者名。集市当前给的是 `authorNickname`，另外两种形状（字符串 / 对象）
 * 是为将来接口收敛留的余地，都吃下来。
 */
function authorOf(row: Record<string, unknown>): { name: string; url?: string } {
  const nickname = str(row.authorNickname)
  if (nickname !== undefined) return { name: nickname }
  const raw = row.author
  if (typeof raw === 'object' && raw !== null) {
    const entry = raw as Record<string, unknown>
    return { name: str(entry.name) ?? '匿名', ...(str(entry.homepage) !== undefined ? { url: str(entry.homepage)! } : {}) }
  }
  return { name: str(raw) ?? str(row.authorName) ?? '匿名' }
}

/** 标签：集市给的是数组，早期字段是逗号分隔的字符串，两种都认。 */
function tagsOf(row: Record<string, unknown>): readonly string[] {
  if (Array.isArray(row.tags)) {
    return row.tags.map(str).filter((tag): tag is string => tag !== undefined)
  }
  return (str(row.tags) ?? '').split(',').map(tag => tag.trim()).filter(tag => tag !== '')
}

/**
 * harness 自己的包不是皮肤。目录里出现这种 spec 只可能是元数据填错
 * （线上就有一条把 packageName 填成 @deepseek-ai/dsh-client-ui-conversation 的），
 * 照着装会把宿主自己的包塞进 profile —— 宁可标成"不可装"，也不能让一条脏数据动用户的环境。
 * @param spec - 推导出来的安装 spec。
 * @returns 可用的 spec；判定为不该装时 undefined。
 */
function safeSpec(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined
  const bare = spec.replace(/^(github|npm|file|link):/, '')
  return bare.startsWith('@deepseek-ai/') || bare.startsWith('dsh-base') ? undefined : spec
}

/**
 * 从集市给的整条安装命令里取出 spec。
 * 形如 `dsh plugin --profile web add github:owner/repo` —— 取最后一个非 flag 的词。
 */
function specFromCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined
  const words = command.trim().split(/\s+/)
  const at = words.lastIndexOf('add')
  if (at < 0 || at + 1 >= words.length) return undefined
  const spec = words[at + 1]
  // 本地路径式的命令（`add <克隆路径>`）不是能直接装的 spec。
  return spec === undefined || spec.startsWith('-') || spec.startsWith('<') ? undefined : spec
}

/**
 * 上游一行 → 目录条目。
 * 缺字段一律兜底，绝不因为某条数据不全就让整页拉不出来。
 * @param raw - 上游 items 里的一项。
 * @returns 归一化条目；连 id 都没有时返回 undefined（这条丢弃）。
 */
export function normalizeEntry(raw: unknown): SkinEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const skinId = str(row.skinId) ?? str(row.id)
  const slug = str(row.slug) ?? str(row.packageName) ?? skinId
  if (skinId === undefined || slug === undefined) return undefined

  const author = authorOf(row)
  const repoUrl = str(row.repoUrl)
  // 优先级：显式 spec → 集市给的整条安装命令 → npm 包名 → 仓库地址推导。
  //
  // installCommand 排在 packageName 前面是有代价换来的：线上有皮肤把 packageName
  // 填成了 harness 自己的包（`@deepseek-ai/dsh-client-ui-conversation`，多半是想表达
  // "我覆盖了这个包"），而同一条的 installCommand 是对的。安装命令是作者写给人照着敲的，
  // 填错了自己先发现；packageName 只是一个没人验证的元数据字段。
  const installSpec = safeSpec(str(row.installSpec)
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
    ...(installSpec !== undefined ? { installSpec } : {}),
    installCount: num(row.installCount),
  }
}

/** 目录服务：一个 dsh 进程一个实例。 */
export class Catalog {
  private readonly origin: string
  private readonly cache = new Map<string, CacheRow>()
  private snapshot: readonly SkinEntry[] | undefined

  /**
   * @param origin - 集市根地址，需含 context-path。
   */
  constructor(origin: string = DEFAULT_CATALOG_ORIGIN) {
    this.origin = origin.replace(/\/+$/, '')
  }

  /**
   * 取一页目录。上游不可用时依次回落到缓存、随包快照，并在结果里说明来源 ——
   * 让用户知道看到的是旧数据，而不是假装在线。
   * @param query - 搜索词、排序、分页。
   * @returns 一页目录，永不抛错。
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
        return { ...cached.page, source: 'cache', staleReason: `集市连不上（${reason}），显示的是本地缓存` }
      }
      return this.fromSnapshot(query, page, size, reason)
    }
  }

  /**
   * 目录里这个安装 spec 对应的条目。
   *
   * 既是安装前的白名单校验（不放行任意包名），也顺手把条目本身交出来 ——
   * 装完要用它的 skinId 回报热度，这样就不必让客户端多传一个可以随便捏造的 id。
   *
   * @param spec - 待校验的安装 spec。
   * @returns 命中的条目；目录里没有时 undefined。
   */
  async findBySpec(spec: string): Promise<SkinEntry | undefined> {
    let scanned = 0
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.page({ page, size: MAX_PAGE_SIZE })
      for (const item of result.items) {
        if (item.installSpec === spec) return item
      }
      // 用「扫过的条目数」而不是「收集到的 spec 数」判断翻到头：没有 installSpec 的条目
      // （元数据不全、装不了的那些）也占 total 的名额，拿去重后的 spec 数比会永远差一截，
      // 于是白白把 10 页翻满。
      scanned += result.items.length
      if (result.items.length === 0 || scanned >= result.total) break
    }
    return undefined
  }

  /** 目录里有没有这个安装 spec —— 安装前的白名单校验，不放行任意包名。 */
  async allows(spec: string): Promise<boolean> {
    return await this.findBySpec(spec) !== undefined
  }

  /**
   * 安装成功后给集市记一次热度。
   *
   * 🔴 <b>绝不影响安装结果</b>：集市挂了、超时、返回业务错误，一律咽下去。
   * 用户的皮肤已经装好了，为一个统计埋点把成功报成失败是本末倒置 ——
   * 所以调用方也应当不 await 它。
   *
   * @param skinId - 集市条目 id。
   * @returns 是否真的记上了，供测试与诊断判断。
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
      // 同 fetchPage：findu 的信封业务失败也回 200，只看状态码会把失败当成功。
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
    // 集市的搜索参数叫 keyword（服务端 LIKE + 分页），不是 q —— 传错名字等于没搜。
    if (query.q !== undefined && query.q !== '') url.searchParams.set('keyword', query.q)
    // sort 的合法取值由集市定义：popular / name / latest（默认）。
    if (query.sort !== undefined && query.sort !== '') url.searchParams.set('sort', query.sort)
    if (query.tag !== undefined && query.tag !== '') url.searchParams.set('tag', query.tag)

    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    // 少了 context-path 时 CloudFront 会回 index.html —— 用 content-type 当场识破，
    // 否则下面的 JSON 解析会抛出一个与真正病因无关的错。
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      throw new Error(`上游返回了 ${contentType || '未知类型'} 而不是 JSON，检查地址是否漏了 /dsh-skin 前缀`)
    }

    const envelope = await response.json() as ApiEnvelope<UpstreamPage>
    // findu 的 ApiResponse 业务失败也回 200，只看状态码会把错误当成空列表。
    if (envelope.code !== undefined && envelope.code !== 'OK') {
      throw new Error(`集市返回 ${envelope.code}：${envelope.message ?? '未说明原因'}`)
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

  /** 随包快照：集市从没连通过时的最后兜底。 */
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
      staleReason: `集市连不上（${reason}），显示的是随插件附带的快照`,
    }
  }
}
