/**
 * Host half: mounts the market's HTTP surface onto dsh's own web server.
 *
 * The client half calls these routes with a same-origin fetch rather than ctx.remote — the
 * remote capability set is fixed at api-remotes build time and third-party plugins cannot add
 * to it (packages/api/remotes/README.zh.md).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { Catalog, DEFAULT_CATALOG_ORIGIN } from './catalog.ts'
import { InstallFailure, allowBuilds, getLastLog, install, pnpmVersion, uninstall } from './installer.ts'
import { isWritable, listInstalled, profileDirOf, resolveIconPath } from './profile.ts'
import { classifySpec } from './spec.ts'
import type { Diagnostics, DiagnosticRow, InstallEvent } from './types.ts'

export { Catalog, DEFAULT_CATALOG_ORIGIN } from './catalog.ts'
export * from './types.ts'

/** Plugin name (the `name` of the loader entry). */
export const name = 'skin-market'

/** Wait for the web server; without it this plugin is pointless. */
export const inject = ['webServer']

/** Route prefix. The client half builds its URLs from the same constant. */
export const API_PREFIX = '/skin-market/api'

/** Plugin config. */
export interface Config {
  /** Registry root URL, including the context path. */
  readonly catalogOrigin?: string
  /**
   * Whether installing is allowed. When off the market is read-only and the install button
   * degrades to "copy install command". For shared machines where writes must be disabled.
   */
  readonly allowInstall?: boolean
}

/**
 * Report one popularity hit to the registry after a successful install.
 *
 * 🔴 <b>Deliberately not awaited.</b> The skin is already installed and this is pure telemetry.
 * A slow or dead registry must not delay the "installed" verdict, still less turn success into
 * failure.
 *
 * Without it, the registry's install counts would only include people who clicked "copy
 * install command" on the web page, missing every one-click install from this plugin and
 * skewing the ranking.
 *
 * @param ctx - Plugin context, used only for logging.
 * @param catalog - The catalog service.
 * @param skinId - The registry entry id, looked up from the spec in the catalog rather than
 *   taken from client input.
 */
function reportInstalled(ctx: Context, catalog: Catalog, skinId: string): void {
  void catalog.reportInstall(skinId).then((recorded) => {
    if (!recorded) {
      ctx.logger.debug('[skin-market] install count was not recorded (skinId=%s); the install result is unaffected', skinId)
    }
  })
}

/** Content types for preview images. Only these are recognised; nothing is guessed. */
const IMAGE_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

/** JSON response. */
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
 * Allow write operations only from a direct local connection.
 *
 * Only the socket's peer address counts, and any forwarding header is an outright refusal —
 * a reverse proxy relaying an external request also looks like 127.0.0.1 on the socket, so the
 * address alone would hollow out the "local installs only" guarantee.
 */
function isDirectLoopback(req: IncomingMessage): boolean {
  if (req.headers['x-forwarded-for'] !== undefined || req.headers['x-forwarded-host'] !== undefined) return false
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Same-origin POST: when Origin is present it must match Host, blocking other pages from commanding the local port. */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** Read a JSON request body, with a size cap. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

/** Open an SSE stream and return a push function. An install can take tens of seconds, and a single response would look hung. */
function openStream(res: ServerResponse): (event: InstallEvent) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  return (event) => { res.write(`data: ${JSON.stringify(event)}\n\n`) }
}

/**
 * Shared shell for install and uninstall: authorise, read parameters, open the stream, run, and
 * emit failures as events on the stream too.
 * @param ctx - Plugin context, for logging.
 * @param config - Plugin config.
 * @param profileDir - The profile directory.
 * @param action - The actual operation.
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
      return json(res, 403, { code: 'INSTALL_DISABLED', message: 'the market is read-only on this machine' })
    }
    if (!isDirectLoopback(req) || !isSameOrigin(req)) {
      return json(res, 403, {
        code: 'NOT_LOOPBACK',
        message: 'installs may only be initiated by a browser connected directly to this machine',
      })
    }
    if (profileDir === undefined) {
      return json(res, 500, { code: 'PROFILE_UNRESOLVED', message: 'cannot locate the profile directory (ctx.baseUrl is empty)' })
    }

    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch (error) {
      return json(res, 400, { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'request body could not be parsed' })
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

/** Diagnostics: what a user checks first when an install fails, and a screen that is easy to paste to us. */
async function diagnose(profileDir: string | undefined, catalog: Catalog): Promise<Diagnostics> {
  const rows: DiagnosticRow[] = []

  if (profileDir === undefined) {
    rows.push({ key: 'profile directory', value: 'unresolved (ctx.baseUrl is empty)', status: 'error' })
  } else {
    const writable = await isWritable(profileDir)
    rows.push({
      key: 'profile directory',
      value: profileDir,
      status: writable ? 'ok' : 'error',
      ...(writable ? {} : { hint: 'directory is not writable; installs will fail' }),
    })
    const version = await pnpmVersion(profileDir)
    rows.push(version === undefined
      ? { key: 'pnpm', value: 'not on PATH', status: 'error', hint: 'try corepack enable pnpm' }
      : { key: 'pnpm', value: version, status: 'ok' })
    rows.push({
      key: 'installed skins',
      value: String((await listInstalled(profileDir)).length),
      status: 'ok',
    })
  }

  const started = Date.now()
  const page = await catalog.page({ page: 1, size: 1 })
  rows.push({
    key: 'registry connectivity',
    value: page.source === 'live'
      ? `ok · ${Date.now() - started}ms · ${page.total} entries`
      : (page.staleReason ?? 'unavailable'),
    status: page.source === 'live' ? 'ok' : 'warn',
  })

  const log = getLastLog()
  return { rows, ...(log === '' ? {} : { lastInstallLog: log }) }
}

/**
 * Mount the market's host half.
 * @param ctx - Plugin context.
 * @param config - Plugin config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalog = new Catalog(config.catalogOrigin ?? DEFAULT_CATALOG_ORIGIN)
  const profileDir = profileDirOf(ctx.baseUrl)

  if (profileDir === undefined) {
    // Not being able to install does not mean not being able to browse: catalog, search and source links all work; only installing reports an explicit error.
    ctx.logger.warn('[skin-market] ctx.baseUrl is empty, so the profile directory cannot be located and installing is unavailable')
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
      // Preview images for installed skins, served from local files rather than the registry's
      // iconUrl: the "installed" screen exists to work offline, and an icon should not be the one
      // thing that still needs the network.
      path: `${API_PREFIX}/icon`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const packageName = url.searchParams.get('package') ?? ''
        if (profileDir === undefined || packageName === '') {
          res.writeHead(404).end()
          return
        }
        // Serve images only for installed packages: the name is checked against the installed list
        // first, so this route does not become a tool for probing what lives in node_modules
        const installed = await listInstalled(profileDir)
        if (!installed.some(row => row.packageName === packageName)) {
          res.writeHead(404).end()
          return
        }
        const file = await resolveIconPath(profileDir, packageName)
        if (file === undefined) {
          res.writeHead(404).end()
          return
        }
        try {
          const body = await readFile(file)
          const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
          res.writeHead(200, {
            'content-type': IMAGE_TYPES[ext] ?? 'application/octet-stream',
            'content-length': body.byteLength,
            // The image travels with the package, so it is stable while the package is; installing a new
            // version keeps the name but changes the content, hence a short cache rather than a long one
            'cache-control': 'private, max-age=300',
          })
          res.end(body)
        } catch {
          res.writeHead(404).end()
        }
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
        if (spec === '') throw new InstallFailure('SPEC_NOT_IN_CATALOG', 'missing install spec')
        // Install only what the registry lists: an arbitrary hand-typed package name is refused.
        const entry = await catalog.findBySpec(spec)
        if (entry === undefined) {
          throw new InstallFailure(
            'SPEC_NOT_IN_CATALOG',
            `${spec} is not in the registry catalog; the market does not install unlisted packages`,
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
        if (packageName === '') throw new InstallFailure('NOT_INSTALLED', 'missing package name')
        await uninstall(dir, packageName, emit)
      }),
    },
    {
      path: `${API_PREFIX}/allow-builds`,
      handler: writeRoute(ctx, config, profileDir, async (dir, body, emit) => {
        const spec = typeof body.spec === 'string' ? body.spec : ''
        if (spec === '') throw new InstallFailure('SPEC_NOT_IN_CATALOG', 'missing spec')
        const entry = await catalog.findBySpec(spec)
        if (entry === undefined) {
          throw new InstallFailure('SPEC_NOT_IN_CATALOG', `${spec} is not in the registry catalog`)
        }
        /*
         * Authorisation only makes sense for git sources.
         *
         * npm packages and tarballs install a published artefact built on the author's side, so
         * hitting BUILD_SCRIPT_BLOCKED can only mean the package itself is broken (missing build
         * output, or a misconfigured files field). Asking the user to permit that package's
         * scripts to run locally fixes nothing and makes them carry the risk for free.
         *
         * It also closes a concrete trap: deriving a bare name from a tarball yields
         * `dsh-niulai-0.1.0.tgz`, and writing that into allowBuilds authorises a dependency name
         * that does not exist, so the retry is guaranteed to fail again.
         */
        const info = classifySpec(spec)
        if (info === undefined) {
          throw new InstallFailure('SPEC_NOT_IN_CATALOG', `${spec} is not an installable spec`)
        }
        if (!info.buildsFromSource || info.bareName === undefined) {
          throw new InstallFailure(
            'BUILD_SCRIPT_BLOCKED',
            `${spec} installs a prebuilt artefact, so build scripts need not — and should not — be authorised.`,
            'A failure here most likely means the package itself is broken (missing build output, or '
            + 'a misconfigured files field in package.json). Authorising its scripts will not fix that; '
            + 'consider telling the author.',
          )
        }
        // The real package name is known only after installing, while authorisation must precede it —
        // so authorise the spec's bare name: pnpm matches allowBuilds by dependency name, and for a
        // git source the bare name is the same.
        await allowBuilds(dir, info.bareName)
        emit({ type: 'log', line: `✓ authorised ${info.bareName} to run build scripts; retrying the install` })
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

  ctx.logger.info('[skin-market] mounted %s/* (profile: %s)', API_PREFIX, profileDir ?? 'unresolved')
}
