/**
 * host 半：把市场的 HTTP 面挂到 dsh 自己的 web 服务上。
 *
 * client 半通过同源 fetch 调这些路由，而不是 ctx.remote —— remote 的能力集在
 * api-remotes 构建期就固定了，第三方插件加不进去（packages/api/remotes/README.zh.md）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Catalog, DEFAULT_CATALOG_ORIGIN } from './catalog.ts'
import { InstallFailure, allowBuilds, getLastLog, install, pnpmVersion, uninstall } from './installer.ts'
import { isWritable, listInstalled, profileDirOf } from './profile.ts'
import { classifySpec } from './spec.ts'
import type { Diagnostics, DiagnosticRow, InstallEvent } from './types.ts'

export { Catalog, DEFAULT_CATALOG_ORIGIN } from './catalog.ts'
export * from './types.ts'

/** 插件名（loader 行的 name）。 */
export const name = 'skin-market'

/** 等 web 服务就绪；没有它这个插件没有意义。 */
export const inject = ['webServer']

/** 路由前缀。client 半按同一个常量拼 URL。 */
export const API_PREFIX = '/skin-market/api'

/** 插件配置。 */
export interface Config {
  /** 集市根地址，需含 context-path。 */
  readonly catalogOrigin?: string
  /**
   * 是否允许安装。关掉后市场只读，安装按钮退化成"复制安装命令"。
   * 共享机器上想彻底禁掉写操作时用。
   */
  readonly allowInstall?: boolean
}

/**
 * 装成功后给集市记一次热度。
 *
 * 🔴 <b>刻意不 await</b>：皮肤此刻已经装好了，回报是纯统计。集市慢或者挂了，
 * 不该让「已装好」这个结论等它，更不该因此把成功报成失败。
 *
 * 没有这一下的话，集市上的装机量只统计得到「在网页上点了复制安装命令」的人，
 * 从本插件一键装的全都不计入，排序会失真。
 *
 * @param ctx - 插件上下文，只用来打日志。
 * @param catalog - 目录服务。
 * @param skinId - 集市条目 id，由 spec 在目录里反查得到，不取客户端传入值。
 */
function reportInstalled(ctx: Context, catalog: Catalog, skinId: string): void {
  void catalog.reportInstall(skinId).then((recorded) => {
    if (!recorded) {
      ctx.logger.debug('[skin-market] 装机量回报没记上（skinId=%s），不影响安装结果', skinId)
    }
  })
}

/** JSON 响应。 */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 直连本机才放行写操作。
 *
 * 只认 socket 的对端地址，并且带了转发头就直接拒 —— 一个反代把外部请求转进来时
 * socket 看着也是 127.0.0.1，仅凭它会把"本机才能装"这条保证架空。
 */
function isDirectLoopback(req: IncomingMessage): boolean {
  if (req.headers['x-forwarded-for'] !== undefined || req.headers['x-forwarded-host'] !== undefined) return false
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 同源 POST：Origin 存在时必须与 Host 一致，挡掉别的网页对本地端口发指令。 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 读 JSON 请求体，带体积上限。 */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

/** 开一条 SSE，返回推事件的函数。安装过程可能几十秒，一次性响应会让用户以为卡死。 */
function openStream(res: ServerResponse): (event: InstallEvent) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  return (event) => { res.write(`data: ${JSON.stringify(event)}\n\n`) }
}

/**
 * 装/卸的公共外壳：鉴权、取参、开流、跑、把失败也当成流里的一条事件发出去。
 * @param ctx - 插件上下文（用于日志）。
 * @param config - 插件配置。
 * @param profileDir - profile 目录。
 * @param action - 实际动作。
 */
function writeRoute(
  ctx: Context,
  config: Config,
  profileDir: string | undefined,
  action: (dir: string, body: Record<string, unknown>, emit: (event: InstallEvent) => void) => Promise<void>,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') return json(res, 405, { code: 'METHOD_NOT_ALLOWED' })
    if (config.allowInstall === false) {
      return json(res, 403, { code: 'INSTALL_DISABLED', message: '这台机器上的市场是只读的' })
    }
    if (!isDirectLoopback(req) || !isSameOrigin(req)) {
      return json(res, 403, {
        code: 'NOT_LOOPBACK',
        message: '安装只允许本机直连的浏览器发起',
      })
    }
    if (profileDir === undefined) {
      return json(res, 500, { code: 'PROFILE_UNRESOLVED', message: '定位不到 profile 目录（ctx.baseUrl 为空）' })
    }

    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch (error) {
      return json(res, 400, { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : '请求体无法解析' })
    }

    const emit = openStream(res)
    try {
      await action(profileDir, body, emit)
    } catch (error) {
      if (error instanceof InstallFailure) {
        emit({
          type: 'error',
          code: error.code,
          message: error.message,
          ...(error.detail !== undefined ? { detail: error.detail } : {}),
        })
      } else {
        ctx.logger.warn(error)
        emit({
          type: 'error',
          code: 'PNPM_FAILED',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      res.end()
    }
  }
}

/** 诊断：装不上时用户第一时间能自查，也方便把这一屏贴给我们。 */
async function diagnose(profileDir: string | undefined, catalog: Catalog): Promise<Diagnostics> {
  const rows: DiagnosticRow[] = []

  if (profileDir === undefined) {
    rows.push({ key: 'profile 目录', value: '未解析（ctx.baseUrl 为空）', status: 'error' })
  } else {
    const writable = await isWritable(profileDir)
    rows.push({
      key: 'profile 目录',
      value: profileDir,
      status: writable ? 'ok' : 'error',
      ...(writable ? {} : { hint: '目录不可写，安装会失败' }),
    })
    const version = await pnpmVersion(profileDir)
    rows.push(version === undefined
      ? { key: 'pnpm', value: '不在 PATH 上', status: 'error', hint: '试试 corepack enable pnpm' }
      : { key: 'pnpm', value: version, status: 'ok' })
    rows.push({
      key: '已安装皮肤',
      value: String((await listInstalled(profileDir)).length),
      status: 'ok',
    })
  }

  const started = Date.now()
  const page = await catalog.page({ page: 1, size: 1 })
  rows.push({
    key: '集市连通性',
    value: page.source === 'live'
      ? `正常 · ${Date.now() - started}ms · 共 ${page.total} 条`
      : (page.staleReason ?? '不可用'),
    status: page.source === 'live' ? 'ok' : 'warn',
  })

  const log = getLastLog()
  return { rows, ...(log === '' ? {} : { lastInstallLog: log }) }
}

/**
 * 挂载市场的 host 半。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalog = new Catalog(config.catalogOrigin ?? DEFAULT_CATALOG_ORIGIN)
  const profileDir = profileDirOf(ctx.baseUrl)

  if (profileDir === undefined) {
    // 装不了不等于不能逛：目录、搜索、源码链接照常可用，只是安装会明确报错。
    ctx.logger.warn('[skin-market] ctx.baseUrl 为空，定位不到 profile 目录，安装功能不可用')
  }

  const routes: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }[] = [
    {
      path: `${API_PREFIX}/catalog`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const page = await catalog.page({
          q: url.searchParams.get('q') ?? undefined,
          sort: url.searchParams.get('sort') ?? undefined,
          page: Number(url.searchParams.get('page') ?? '1') || 1,
          size: Number(url.searchParams.get('size') ?? '24') || 24,
        })
        json(res, 200, page)
      },
    },
    {
      path: `${API_PREFIX}/installed`,
      handler: async (_req, res) => {
        json(res, 200, { items: profileDir === undefined ? [] : await listInstalled(profileDir) })
      },
    },
    {
      path: `${API_PREFIX}/diagnostics`,
      handler: async (_req, res) => { json(res, 200, await diagnose(profileDir, catalog)) },
    },
    {
      path: `${API_PREFIX}/install`,
      handler: writeRoute(ctx, config, profileDir, async (dir, body, emit) => {
        const spec = typeof body.spec === 'string' ? body.spec : ''
        if (spec === '') throw new InstallFailure('SPEC_NOT_IN_CATALOG', '缺少安装 spec')
        // 只装集市收录过的东西：用户手输任意包名不放行。
        const entry = await catalog.findBySpec(spec)
        if (entry === undefined) {
          throw new InstallFailure(
            'SPEC_NOT_IN_CATALOG',
            `${spec} 不在集市目录里，市场不代装未收录的包`,
          )
        }
        await install(dir, spec, emit)
        reportInstalled(ctx, catalog, entry.skinId)
      }),
    },
    {
      path: `${API_PREFIX}/uninstall`,
      handler: writeRoute(ctx, config, profileDir, async (dir, body, emit) => {
        const packageName = typeof body.packageName === 'string' ? body.packageName : ''
        if (packageName === '') throw new InstallFailure('NOT_INSTALLED', '缺少包名')
        await uninstall(dir, packageName, emit)
      }),
    },
    {
      path: `${API_PREFIX}/allow-builds`,
      handler: writeRoute(ctx, config, profileDir, async (dir, body, emit) => {
        const spec = typeof body.spec === 'string' ? body.spec : ''
        if (spec === '') throw new InstallFailure('SPEC_NOT_IN_CATALOG', '缺少 spec')
        const entry = await catalog.findBySpec(spec)
        if (entry === undefined) {
          throw new InstallFailure('SPEC_NOT_IN_CATALOG', `${spec} 不在集市目录里`)
        }
        /*
         * 授权只对 git 源成立。
         *
         * npm 包和 tarball 装的是发布物，构建在作者那边就做完了 —— 它们撞上
         * BUILD_SCRIPT_BLOCKED 只可能是包本身有毛病（漏了构建产物、files 配错），
         * 让用户授权「在本机执行这个包的脚本」既解决不了问题，又白白让他承担了风险。
         *
         * 顺带堵掉一个具体的坑：tarball 的裸名推导会得到 `dsh-niulai-0.1.0.tgz`，
         * 拿它去写 allowBuilds 是授权了一个不存在的依赖名，重试必然再失败一次。
         */
        const info = classifySpec(spec)
        if (info === undefined) {
          throw new InstallFailure('SPEC_NOT_IN_CATALOG', `${spec} 不是一条可安装的 spec`)
        }
        if (!info.buildsFromSource || info.bareName === undefined) {
          throw new InstallFailure(
            'BUILD_SCRIPT_BLOCKED',
            `${spec} 装的是预构建的发布物，不需要、也不应该授权构建脚本。`,
            '装不上多半是这个包自己有问题（缺构建产物，或者 package.json 的 files 配错了），'
            + '授权执行它的脚本解决不了，建议向作者反馈。',
          )
        }
        // 真实包名要装完才知道，而授权必须发生在装之前 —— 用 spec 的裸名授权，
        // pnpm 的 allowBuilds 按依赖名匹配，git 源的裸名与之一致。
        await allowBuilds(dir, info.bareName)
        emit({ type: 'log', line: `✓ 已授权 ${info.bareName} 运行构建脚本，正在重试安装` })
        await install(dir, spec, emit)
        reportInstalled(ctx, catalog, entry.skinId)
      }),
    },
  ]

  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      `skin-market: ${route.path}`,
    )
  }

  ctx.logger.info('[skin-market] 已挂载 %s/*（profile: %s）', API_PREFIX, profileDir ?? '未解析')
}
