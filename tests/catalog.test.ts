/**
 * 目录归一化与降级。集市的字段还在补齐中，所以这里的重点是：
 * 缺字段不能让整页拉不出来，上游异常不能让设置页白屏。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Catalog, normalizeEntry } from '../src/catalog.ts'

test('最小字段也能归一化出一条', () => {
  const entry = normalizeEntry({ skinId: 'skin_1', slug: 'dsh-cool' })
  assert.equal(entry?.skinId, 'skin_1')
  assert.equal(entry?.name, 'dsh-cool')
  assert.equal(entry?.author, '匿名')
  assert.equal(entry?.starCount, 0)
})

test('连 id 都没有的行丢弃，而不是塞一条空卡片进列表', () => {
  assert.equal(normalizeEntry({ name: '没有 id' }), undefined)
  assert.equal(normalizeEntry(null), undefined)
  assert.equal(normalizeEntry('字符串'), undefined)
})

test('安装 spec 优先 npm 包名，没有才从仓库地址推 github:', () => {
  const npm = normalizeEntry({
    skinId: 's1', slug: 'a', packageName: 'dsh-cool-skin',
    repoUrl: 'https://github.com/owner/dsh-cool-skin',
  })
  assert.equal(npm?.installSpec, 'dsh-cool-skin')

  const git = normalizeEntry({ skinId: 's2', slug: 'b', repoUrl: 'https://github.com/owner/repo.git' })
  assert.equal(git?.installSpec, 'github:owner/repo')

  // 两者都没有 = 不可装，UI 据此禁用按钮而不是点了才失败。
  const neither = normalizeEntry({ skinId: 's3', slug: 'c' })
  assert.equal(neither?.installSpec, undefined)
})

test('作者既可以是字符串也可以是对象', () => {
  assert.equal(normalizeEntry({ skinId: 's', slug: 'x', author: 'someone' })?.author, 'someone')
  const rich = normalizeEntry({
    skinId: 's', slug: 'x',
    author: { name: 'someone', homepage: 'https://github.com/someone' },
  })
  assert.equal(rich?.author, 'someone')
  assert.equal(rich?.authorUrl, 'https://github.com/someone')
})

test('封面缺失时退到 media 里的 COVER', () => {
  const entry = normalizeEntry({
    skinId: 's', slug: 'x',
    media: [{ kind: 'SCREENSHOT', url: 'shot.png' }, { kind: 'COVER', url: 'cover.png' }],
  })
  assert.equal(entry?.iconUrl, 'cover.png')
})

test('日期统一成 YYYY-MM-DD，认不出的原样截断而不是崩掉', () => {
  assert.equal(normalizeEntry({ skinId: 's', slug: 'x', releasedAt: '2026-08-16T03:04:05Z' })?.releasedAt, '2026-08-16')
  assert.equal(normalizeEntry({ skinId: 's', slug: 'x', releasedAt: '不是日期' })?.releasedAt, '不是日期')
})

test('上游返回 HTML（漏了 context-path）时报出可读原因，并回落到快照', async () => {
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

test('业务失败（code 非 OK）不当成空列表 —— HTTP 200 也要验 code', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 'SKIN_QUERY_FAILED', message: '数据库连接失败' }))
  })
  try {
    const page = await new Catalog(server.origin).page({ page: 1, size: 5 })
    assert.equal(page.source, 'snapshot')
    assert.match(page.staleReason ?? '', /SKIN_QUERY_FAILED|数据库连接失败/)
  } finally {
    await server.close()
  }
})

test('正常响应归一化成一页，坏行被跳过而不是整页失败', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      code: 'OK',
      data: {
        total: 2,
        items: [
          { skinId: 's1', slug: 'dsh-cool', name: '酷皮肤', packageName: 'dsh-cool', starCount: 12 },
          { 没有: 'id' },
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

test('第二次同样的查询走缓存，不再打上游', async () => {
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

test('目录里没有的 spec 不放行 —— 安装白名单', async () => {
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

/** 起一个一次性 HTTP 服务，返回它的 origin 与关闭函数。 */
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

test('吃集市当前的真实字段形状：authorNickname / tags 数组 / installCommand / coverUrl', () => {
  const entry = normalizeEntry({
    skinId: 'skin_01M0',
    slug: 'touhou-hakurei',
    name: '博丽神社 · 灵梦',
    tagline: '东方Project 灵梦主题',
    repoUrl: 'https://github.com/xiake595/touhou-hakurei',
    packageName: null,
    installCommand: 'dsh plugin --profile web add github:xiake595/touhou-hakurei',
    tags: ['二次元', '东方Project'],
    authorNickname: '本地推理门将',
    coverUrl: 'https://example.com/cover.webp',
    updatedAt: '2026-08-18T17:48:33',
    installCount: 3,
  })
  assert.equal(entry?.author, '本地推理门将')
  assert.equal(entry?.category, '二次元')
  assert.equal(entry?.iconUrl, 'https://example.com/cover.webp')
  assert.equal(entry?.installSpec, 'github:xiake595/touhou-hakurei')
  assert.equal(entry?.releasedAt, '2026-08-18')
  assert.equal(entry?.installCount, 3)
})

test('安装命令里是占位路径时不当成 spec —— 那种只能手动装', () => {
  const entry = normalizeEntry({
    skinId: 's', slug: 'x',
    installCommand: 'dsh plugin --profile web add <克隆路径>',
  })
  assert.equal(entry?.installSpec, undefined)
})

test('搜索走集市的 keyword 参数（服务端 LIKE + 分页），不是 q，也不在本地伪过滤', async () => {
  let seen = ''
  const server = await serve((req, res) => {
    seen = req.url ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      code: 'OK',
      // 服务端已经筛过了：返回什么就是什么，客户端不得再过滤一遍。
      data: { total: 1, page: 2, size: 5, items: [{ skinId: 's1', slug: 'dsh-qq2006', name: 'QQ 2006' }] },
    }))
  })
  try {
    const page = await new Catalog(server.origin).page({ q: 'qq', sort: 'popular', tag: '怀旧', page: 2, size: 5 })
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

test('packageName 填成 harness 自己的包时，宁可标不可装也不照着装', () => {
  // 线上真实脏数据：packageName 是 @deepseek-ai/dsh-client-ui-conversation，
  // 而 installCommand 才是对的。
  const entry = normalizeEntry({
    skinId: 's', slug: 'dsh-qq2006',
    packageName: '@deepseek-ai/dsh-client-ui-conversation',
    installCommand: 'dsh plugin --profile web add github:LaplaceYoung/dsh-qq2006',
    repoUrl: 'https://github.com/LaplaceYoung/dsh-qq2006',
  })
  assert.equal(entry?.installSpec, 'github:LaplaceYoung/dsh-qq2006')
})

test('只剩宿主自己的包可选时，这条就是不可装', () => {
  const entry = normalizeEntry({
    skinId: 's', slug: 'x', packageName: '@deepseek-ai/dsh-client-ui-conversation',
  })
  assert.equal(entry?.installSpec, undefined)
})

test('装机量回报打到 install-hit，且 skinId 做过转义', async () => {
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

    // id 里混进路径字符也不能拼出越界的 URL。
    await catalog.reportInstall('a/../b')
    assert.equal(seen[1], 'POST /api/v1/public/skins/a%2F..%2Fb/install-hit')
  } finally {
    await server.close()
  }
})

test('回报失败只返回 false，绝不抛 —— 皮肤已经装好了，不能因埋点把成功报成失败', async () => {
  // 业务失败（HTTP 200 + code 非 OK）
  const soft = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 'SKIN_NOT_FOUND', message: '没有这个皮肤' }))
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

  // 集市根本连不上
  assert.equal(await new Catalog('http://127.0.0.1:1').reportInstall('skin_x'), false)
})

test('findBySpec 命中后把整条给出来，skinId 由目录说了算而不是客户端传', async () => {
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
    assert.equal(await catalog.allows('随便一个包名'), false)
  } finally {
    await server.close()
  }
})

test('目录里有装不了的条目时，findBySpec 不会白翻满 10 页', async () => {
  let hits = 0
  const server = await serve((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    // 两条都没有 installSpec：旧实现按「收集到的 spec 数」比 total，永远凑不够，会一路翻到第 10 页。
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
