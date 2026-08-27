/**
 * Catalog normalisation and degradation. The registry's fields are still being filled in, so
 * what matters here is: a missing field must not take down a whole page, and an upstream fault
 * must not leave the settings page blank.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Catalog, normalizeEntry } from '../src/catalog.ts'

test('a minimal record still normalises into one entry', () => {
  const entry = normalizeEntry({ skinId: 'skin_1', slug: 'dsh-cool' })
  assert.equal(entry?.skinId, 'skin_1')
  assert.equal(entry?.name, 'dsh-cool')
  assert.equal(entry?.author, 'anonymous')
  assert.equal(entry?.starCount, 0)
})

test('a row without even an id is dropped rather than pushed into the list as an empty card', () => {
  assert.equal(normalizeEntry({ name: 'no id' }), undefined)
  assert.equal(normalizeEntry(null), undefined)
  assert.equal(normalizeEntry('a string'), undefined)
})

test('the install spec prefers the npm name, deriving github: from the repo URL only when absent', () => {
  const npm = normalizeEntry({
    skinId: 's1', slug: 'a', packageName: 'dsh-cool-skin',
    repoUrl: 'https://github.com/owner/dsh-cool-skin',
  })
  assert.equal(npm?.installSpec, 'dsh-cool-skin')

  const git = normalizeEntry({ skinId: 's2', slug: 'b', repoUrl: 'https://github.com/owner/repo.git' })
  assert.equal(git?.installSpec, 'github:owner/repo')

  // Neither present means uninstallable, and the UI disables the button rather than failing after a click.
  const neither = normalizeEntry({ skinId: 's3', slug: 'c' })
  assert.equal(neither?.installSpec, undefined)
})

test('every installable entry carries a source kind and a manual command, which the UI uses to change its wording', () => {
  const npm = normalizeEntry({ skinId: 's', slug: 'a', packageName: 'dsh-cool-skin' })
  assert.equal(npm?.installKind, 'npm')
  assert.equal(npm?.installCommand, 'dsh plugin --profile web add -w dsh-cool-skin')

  const git = normalizeEntry({ skinId: 's', slug: 'b', repoUrl: 'https://github.com/owner/repo' })
  assert.equal(git?.installKind, 'github')

  const tarball = normalizeEntry({
    skinId: 's', slug: 'c',
    installSpec: 'https://github.com/o/r/releases/download/v1/dsh-cool-0.1.0.tgz',
  })
  assert.equal(tarball?.installKind, 'tarball')

  // Uninstallable entries have no kind either: the two live and die together, so the UI need not null-check them separately.
  const none = normalizeEntry({ skinId: 's', slug: 'd' })
  assert.equal(none?.installKind, undefined)
  assert.equal(none?.installCommand, undefined)
})

test('🔴 a monorepo repo URL is no longer forced into "install the whole repository"', () => {
  // Once 21 skins merged into one repository, a repoUrl pointing at a subdirectory became the
  // norm. The old regex forced it into `github:org/skins`, so the user waited out a clone only
  // to fail at the mount step.
  const entry = normalizeEntry({
    skinId: 's', slug: 'niulai',
    repoUrl: 'https://github.com/keman-ai/skins/tree/main/packages/niulai',
  })
  assert.equal(entry?.installSpec, undefined)
  assert.equal(entry?.installKind, undefined)
})

test('🔴 a harness package spelled as github: is blocked too', () => {
  // The old safeSpec prefix-matched the whole spec; stripping `github:` leaves
  // `deepseek-ai/dsh-base`, which starts with no reserved name and slipped straight through.
  // The test must run on the derived package name.
  const entry = normalizeEntry({ skinId: 's', slug: 'x', packageName: 'github:deepseek-ai/dsh-base' })
  assert.equal(entry?.installSpec, undefined)
})

test('the author may be either a string or an object', () => {
  assert.equal(normalizeEntry({ skinId: 's', slug: 'x', author: 'someone' })?.author, 'someone')
  const rich = normalizeEntry({
    skinId: 's', slug: 'x',
    author: { name: 'someone', homepage: 'https://github.com/someone' },
  })
  assert.equal(rich?.author, 'someone')
  assert.equal(rich?.authorUrl, 'https://github.com/someone')
})

test('a missing cover falls back to the COVER entry in media', () => {
  const entry = normalizeEntry({
    skinId: 's', slug: 'x',
    media: [{ kind: 'SCREENSHOT', url: 'shot.png' }, { kind: 'COVER', url: 'cover.png' }],
  })
  assert.equal(entry?.iconUrl, 'cover.png')
})

test('dates normalise to YYYY-MM-DD; unrecognised ones are truncated verbatim rather than crashing', () => {
  assert.equal(normalizeEntry({ skinId: 's', slug: 'x', releasedAt: '2026-08-16T03:04:05Z' })?.releasedAt, '2026-08-16')
  assert.equal(normalizeEntry({ skinId: 's', slug: 'x', releasedAt: 'not a date' })?.releasedAt, 'not a date')
})

test('HTML from upstream (a missing context path) reports a readable reason and falls back to the snapshot', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html></html>')
  })
  try {
    const page = await new Catalog(server.origin).page({ page: 1, size: 5 })
    assert.equal(page.source, 'snapshot')
    assert.match(page.staleReason ?? '', /dsh-skin/)
  } finally {
    await server.close()
  }
})

test('a business failure (code other than OK) is not read as an empty list — code must be checked even on HTTP 200', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 'SKIN_QUERY_FAILED', message: 'database connection failed' }))
  })
  try {
    const page = await new Catalog(server.origin).page({ page: 1, size: 5 })
    assert.equal(page.source, 'snapshot')
    assert.match(page.staleReason ?? '', /SKIN_QUERY_FAILED|database connection failed/)
  } finally {
    await server.close()
  }
})

test('a normal response normalises into a page, with bad rows skipped rather than failing the page', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      code: 'OK',
      data: {
        total: 2,
        items: [
          { skinId: 's1', slug: 'dsh-cool', name: 'Cool Skin', packageName: 'dsh-cool', starCount: 12 },
          { missing: 'id' },
        ],
      },
    }))
  })
  try {
    const page = await new Catalog(server.origin).page({ page: 1, size: 5 })
    assert.equal(page.source, 'live')
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0]?.starCount, 12)
  } finally {
    await server.close()
  }
})

test('a repeated query is served from cache and never hits upstream again', async () => {
  let hits = 0
  const server = await serve((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 'OK', data: { total: 0, items: [] } }))
  })
  try {
    const catalog = new Catalog(server.origin)
    await catalog.page({ page: 1, size: 5 })
    await catalog.page({ page: 1, size: 5 })
    assert.equal(hits, 1)
  } finally {
    await server.close()
  }
})

test('a spec absent from the catalog is refused — the install allowlist', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      code: 'OK',
      data: { total: 1, items: [{ skinId: 's1', slug: 'ok-skin', packageName: 'ok-skin' }] },
    }))
  })
  try {
    const catalog = new Catalog(server.origin)
    assert.equal(await catalog.allows('ok-skin'), true)
    assert.equal(await catalog.allows('evil-package'), false)
  } finally {
    await server.close()
  }
})

/** Start a throwaway HTTP server, returning its origin and a close function. */
async function serve(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const { createServer } = await import('node:http')
  const server = createServer(handler)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

test("accepts the registry's current field shapes: authorNickname / tags array / installCommand / coverUrl", () => {
  const entry = normalizeEntry({
    skinId: 'skin_01M0',
    slug: 'touhou-hakurei',
    name: 'Hakurei Shrine · Reimu',
    tagline: 'A Touhou Project Reimu theme',
    repoUrl: 'https://github.com/xiake595/touhou-hakurei',
    packageName: null,
    installCommand: 'dsh plugin --profile web add github:xiake595/touhou-hakurei',
    tags: ['anime', 'touhou'],
    authorNickname: 'local-inference-keeper',
    coverUrl: 'https://example.com/cover.webp',
    updatedAt: '2026-08-18T17:48:33',
    installCount: 3,
  })
  assert.equal(entry?.author, 'local-inference-keeper')
  assert.equal(entry?.category, 'anime')
  assert.equal(entry?.iconUrl, 'https://example.com/cover.webp')
  assert.equal(entry?.installSpec, 'github:xiake595/touhou-hakurei')
  assert.equal(entry?.releasedAt, '2026-08-18')
  assert.equal(entry?.installCount, 3)
})

test('a placeholder path in the install command is not treated as a spec — those install manually only', () => {
  const entry = normalizeEntry({
    skinId: 's', slug: 'x',
    installCommand: 'dsh plugin --profile web add <path to clone>',
  })
  assert.equal(entry?.installSpec, undefined)
})

test("search uses the registry's keyword parameter (server-side LIKE + pagination), not q, and never fakes filtering locally", async () => {
  let seen = ''
  const server = await serve((req, res) => {
    seen = req.url ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      code: 'OK',
      // The server already filtered: whatever comes back stands, and the client must not filter again.
      data: { total: 1, page: 2, size: 5, items: [{ skinId: 's1', slug: 'dsh-qq2006', name: 'QQ 2006' }] },
    }))
  })
  try {
    const page = await new Catalog(server.origin).page({ q: 'qq', sort: 'popular', tag: 'retro', page: 2, size: 5 })
    assert.match(seen, /keyword=qq/)
    assert.match(seen, /sort=popular/)
    assert.match(seen, /tag=/)
    assert.match(seen, /page=2/)
    assert.doesNotMatch(seen, /[?&]q=/)
    assert.equal(page.items.length, 1)
    assert.equal(page.total, 1)
  } finally {
    await server.close()
  }
})

test('when packageName names a harness package, mark it uninstallable rather than install it as written', () => {
  // Real dirty data from production: packageName is @deepseek-ai/dsh-client-ui-conversation,
  // while installCommand is the correct one.
  const entry = normalizeEntry({
    skinId: 's', slug: 'dsh-qq2006',
    packageName: '@deepseek-ai/dsh-client-ui-conversation',
    installCommand: 'dsh plugin --profile web add github:LaplaceYoung/dsh-qq2006',
    repoUrl: 'https://github.com/LaplaceYoung/dsh-qq2006',
  })
  assert.equal(entry?.installSpec, 'github:LaplaceYoung/dsh-qq2006')
})

test('when only a host package remains as a candidate, the entry is uninstallable', () => {
  const entry = normalizeEntry({
    skinId: 's', slug: 'x', packageName: '@deepseek-ai/dsh-client-ui-conversation',
  })
  assert.equal(entry?.installSpec, undefined)
})

test('the popularity report hits install-hit with an escaped skinId', async () => {
  const seen: string[] = []
  const server = await serve((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 'OK', data: null }))
  })
  try {
    const catalog = new Catalog(server.origin)
    assert.equal(await catalog.reportInstall('skin_01M0A3'), true)
    assert.deepEqual(seen, ['POST /api/v1/public/skins/skin_01M0A3/install-hit'])

    // Path characters inside an id must never compose an out-of-bounds URL.
    await catalog.reportInstall('a/../b')
    assert.equal(seen[1], 'POST /api/v1/public/skins/a%2F..%2Fb/install-hit')
  } finally {
    await server.close()
  }
})

test('a failed report returns false and never throws — the skin is installed, and telemetry must not turn success into failure', async () => {
  // Business failure (HTTP 200 with a code other than OK)
  const soft = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 'SKIN_NOT_FOUND', message: 'no such skin' }))
  })
  try {
    assert.equal(await new Catalog(soft.origin).reportInstall('skin_x'), false)
  } finally {
    await soft.close()
  }

  // HTTP 5xx
  const hard = await serve((_req, res) => { res.writeHead(500); res.end('boom') })
  try {
    assert.equal(await new Catalog(hard.origin).reportInstall('skin_x'), false)
  } finally {
    await hard.close()
  }

  // The registry is not reachable at all
  assert.equal(await new Catalog('http://127.0.0.1:1').reportInstall('skin_x'), false)
})

test('findBySpec hands back the whole entry, with skinId decided by the catalog rather than sent by the client', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      code: 'OK',
      data: {
        total: 2,
        items: [
          { skinId: 'skin_a', slug: 'a', packageName: 'dsh-a' },
          { skinId: 'skin_b', slug: 'b', packageName: 'dsh-b' },
        ],
      },
    }))
  })
  try {
    const catalog = new Catalog(server.origin)
    assert.equal((await catalog.findBySpec('dsh-b'))?.skinId, 'skin_b')
    assert.equal(await catalog.findBySpec('dsh-not-there'), undefined)
    assert.equal(await catalog.allows('dsh-a'), true)
    assert.equal(await catalog.allows('any-old-package-name'), false)
  } finally {
    await server.close()
  }
})

test('with uninstallable entries in the catalog, findBySpec does not needlessly walk all ten pages', async () => {
  let hits = 0
  const server = await serve((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    // Neither has an installSpec: the old implementation compared collected specs against total, never reached it, and walked to page ten.
    res.end(JSON.stringify({
      code: 'OK',
      data: { total: 2, items: [{ skinId: 's1', slug: 'a' }, { skinId: 's2', slug: 'b' }] },
    }))
  })
  try {
    assert.equal(await new Catalog(server.origin).findBySpec('dsh-x'), undefined)
    assert.equal(hits, 1)
  } finally {
    await server.close()
  }
})

test('the spec is still extracted when the command carries -w — the registry adds that required flag', () => {
  const withFlag = normalizeEntry({
    skinId: 's', slug: 'x',
    installCommand: 'dsh plugin --profile web add -w github:owner/repo',
  })
  assert.equal(withFlag?.installSpec, 'github:owner/repo')

  const npmPkg = normalizeEntry({
    skinId: 's', slug: 'x',
    installCommand: 'dsh plugin --profile web add -w dsh-theme-plugin',
  })
  assert.equal(npmPkg?.installSpec, 'dsh-theme-plugin')
})
