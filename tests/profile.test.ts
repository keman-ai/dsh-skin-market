/** profile patch 层的读写。改的是用户自己的配置文件，所以每条保证都要有测试盯着。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyBundlePatch, findBySpec, listInstalled, profileDirOf, removeRow } from '../src/profile.ts'

/** 一个临时 profile 目录。 */
async function makeProfile(patch?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'skin-market-'))
  if (patch !== undefined) await writeFile(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  return dir
}

/**
 * 在 profile 里造一个已安装的皮肤包。
 * @param dir - profile 目录。
 * @param name - 包名（可带 scope）。
 * @param patch - 该包 cordis.patch.yml 的内容；省略表示没有 dsh.bundle 声明。
 */
async function fakePackage(dir: string, name: string, patch?: string): Promise<void> {
  const packageDir = join(dir, 'node_modules', ...name.split('/'))
  await mkdir(packageDir, { recursive: true })
  const manifest: Record<string, unknown> = { name, version: '1.2.3' }
  if (patch !== undefined) {
    manifest.dsh = { bundle: { patch: './cordis.patch.yml' } }
    await writeFile(join(packageDir, 'cordis.patch.yml'), patch, 'utf8')
  }
  await writeFile(join(packageDir, 'package.json'), JSON.stringify(manifest), 'utf8')
}

const patchOf = (dir: string): Promise<string> => readFile(join(dir, 'cordis.patch.yml'), 'utf8')

/** 皮肤包真实的那种层：顶层行，不是 insert 包装。 */
const QQ_PATCH = `# mount the QQ2006 skin
- id: ui-skin-qq2006
  name: '@dsh-external/dsh-qq2006'
`

test('原样内联包自己声明的层 —— id 与包名都取自作者，不是我们猜的', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)

  assert.equal((await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')).rows, 1)
  const text = await patchOf(dir)
  // 包名带 scope，行的 id 是作者定的 ui-skin-qq2006 —— 两者都不能是我们猜的。
  assert.match(text, /id: ui-skin-qq2006/)
  assert.match(text, /@dsh-external\/dsh-qq2006/)
})

test('作者用 insert 形状时也原样保持', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'dsh-other-skin', '- insert:\n    - id: other\n      name: dsh-other-skin\n')

  await applyBundlePatch(dir, 'dsh-other-skin')
  assert.match(await patchOf(dir), /insert:/)
})

test('一个包贡献多行时全部搬过来', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'dsh-two-row', [
    '- insert:',
    '    - id: a',
    '      name: dsh-two-row',
    '- id: agent-default-model',
    '  config:',
    '    provider: x',
    '',
  ].join('\n'))

  assert.equal((await applyBundlePatch(dir, 'dsh-two-row')).rows, 2)
  const installed = await listInstalled(dir)
  assert.equal(installed.length, 1)
  assert.equal(installed[0]?.packageName, 'dsh-two-row')
})

test('重复安装幂等，不会搬第二遍', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')
  assert.equal((await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')).rows, 0)
  assert.equal((await patchOf(dir)).match(/id: ui-skin-qq2006/g)?.length, 1)
})

test('没有 dsh.bundle 声明的包不是皮肤，拒绝挂载', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'just-a-library')
  await assert.rejects(
    () => applyBundlePatch(dir, 'just-a-library'),
    /没有声明 dsh.bundle.patch/,
  )
})

test('用户自己写的行和注释原样保留，卸载只摘我们标记过的', async () => {
  const original = [
    '# 我自己的配置，别动',
    '- insert:',
    '    - id: my-own-plugin',
    '      name: some-plugin',
    '',
  ].join('\n')
  const dir = await makeProfile(original)
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)

  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')
  const afterAdd = await patchOf(dir)
  assert.match(afterAdd, /# 我自己的配置，别动/)
  assert.match(afterAdd, /id: my-own-plugin/)

  assert.equal(await removeRow(dir, '@dsh-external/dsh-qq2006'), true)
  const afterRemove = await patchOf(dir)
  assert.match(afterRemove, /# 我自己的配置，别动/)
  assert.match(afterRemove, /id: my-own-plugin/)
  assert.doesNotMatch(afterRemove, /ui-skin-qq2006/)
})

test('已安装列表认的是归属标记，不把用户自己的插件算进来', async () => {
  const dir = await makeProfile([
    '- insert:',
    '    - id: my-own-plugin',
    '      name: some-plugin',
    '',
  ].join('\n'))
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')

  const installed = await listInstalled(dir)
  assert.equal(installed.length, 1)
  assert.equal(installed[0]?.packageName, '@dsh-external/dsh-qq2006')
  assert.equal(installed[0]?.version, '1.2.3')
})

test('已安装列表带上 profile 里记录的依赖 spec —— 前端按它判断装没装', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { '@dsh-external/dsh-qq2006': 'github:LaplaceYoung/dsh-qq2006' } }),
    'utf8',
  )
  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')

  const installed = await listInstalled(dir)
  assert.equal(installed[0]?.spec, 'github:LaplaceYoung/dsh-qq2006')
})

test('patch 文件不是条目数组时报错，绝不覆盖用户的文件', async () => {
  const dir = await makeProfile('someKey: 请不要把我变成数组\n')
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await assert.rejects(() => applyBundlePatch(dir, '@dsh-external/dsh-qq2006'), /不是 patch 条目数组/)
  assert.equal(await patchOf(dir), 'someKey: 请不要把我变成数组\n')
})

test('卸载一个没装过的包只是返回 false，不抛', async () => {
  const dir = await makeProfile()
  assert.equal(await removeRow(dir, 'never-installed'), false)
})

test('ctx.baseUrl 是 file:// URL 或裸路径都能解成目录', () => {
  assert.equal(profileDirOf('/Users/x/.dsh/profiles/web'), '/Users/x/.dsh/profiles/web')
  assert.equal(profileDirOf('file:///Users/x/.dsh/profiles/web'), '/Users/x/.dsh/profiles/web')
  assert.equal(profileDirOf(undefined), undefined)
  assert.equal(profileDirOf(''), undefined)
})

test('把"挂载自己"写成"改一行"的笔误会被接住 —— 否则装了静默不生效', async () => {
  const dir = await makeProfile()
  // 线上真实写法：没有 insert，id 是新的，name 是自己 —— applyEntryPatches 会
  // 因为找不到该 id 而跳过，走官方 bundles 机制也一样不生效。
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)

  const applied = await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')
  assert.equal(applied.rows, 1)
  assert.equal(applied.repaired, 1)

  const text = await patchOf(dir)
  assert.match(text, /insert:/)
  // 修正的行由我们统一命名，作者那个从没生效过的 id 不留在配置里，
  // 但记进注释以便追溯。
  assert.match(text, /id: skin:@dsh-external\/dsh-qq2006/)
  assert.doesNotMatch(text, /^\s*- id: ui-skin-qq2006/m)
  assert.match(text, /已修正，原 id: ui-skin-qq2006/)
})

test('新建的 patch 文件是块状 YAML，不是挤成一行的 flow 风格', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')

  const text = await patchOf(dir)
  assert.doesNotMatch(text, /^\[/)
  assert.match(text, /^- insert:$/m)
})

test('写进去的行能原样读回来 —— id 里的冒号不会把 YAML 解析带偏', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')

  const { parse } = await import('yaml')
  const parsed = parse(await patchOf(dir)) as { insert: { id: string; name: string }[] }[]
  assert.equal(parsed[0]?.insert[0]?.id, 'skin:@dsh-external/dsh-qq2006')
  assert.equal(parsed[0]?.insert[0]?.name, '@dsh-external/dsh-qq2006')
})

test('同一个包修正多行时 id 不撞', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'dsh-multi', [
    '- id: row-a',
    "  name: 'dsh-multi'",
    '- id: row-b',
    "  name: 'dsh-multi'",
    '',
  ].join('\n'))

  const applied = await applyBundlePatch(dir, 'dsh-multi')
  assert.equal(applied.repaired, 2)
  const text = await patchOf(dir)
  assert.match(text, /id: skin:dsh-multi$/m)
  assert.match(text, /id: skin:dsh-multi#2/)
})

test('作者写对的行连 id 都不碰 —— 同包多行可能靠 id 互相引用', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'dsh-linked', [
    '- insert:',
    '    - id: author-row',
    '      name: dsh-linked',
    '- id: author-row',
    '  config:',
    '    tone: warm',
    '',
  ].join('\n'))

  const applied = await applyBundlePatch(dir, 'dsh-linked')
  assert.equal(applied.repaired, 0)
  const text = await patchOf(dir)
  // 两行都得保持 author-row，否则后一行的覆盖就落空了。
  assert.equal(text.match(/author-row/g)?.length, 2)
  assert.doesNotMatch(text, /skin:dsh-linked/)
})

test('真正的覆盖型 patch 不碰 —— 判据是 name 必须正是这个包自己', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'dsh-tweaker', [
    '# 覆盖别人的行：name 指向别的包',
    "- id: agent-default-model",
    "  name: '@deepseek-ai/dsh-agent'",
    '  config:',
    '    provider: x',
    '',
  ].join('\n'))

  const applied = await applyBundlePatch(dir, 'dsh-tweaker')
  assert.equal(applied.repaired, 0)
  assert.doesNotMatch(await patchOf(dir), /insert:/)
})

test('不写 name 的覆盖型 patch 也不碰', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'dsh-tweaker2', '- id: agent-default-model\n  config:\n    provider: y\n')
  const applied = await applyBundlePatch(dir, 'dsh-tweaker2')
  assert.equal(applied.repaired, 0)
})

test('按 spec 反查包名 —— 依赖已在时靠它认出装的是哪个包', async () => {
  const dir = await makeProfile()
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    dependencies: {
      '@dsh-external/dsh-qq2006': 'github:LaplaceYoung/dsh-qq2006',
      'other-plugin': '^1.0.0',
    },
  }), 'utf8')

  assert.equal(
    await findBySpec(dir, 'github:LaplaceYoung/dsh-qq2006'),
    '@dsh-external/dsh-qq2006',
  )
  // pnpm 有时会缀上 commit，去掉 # 之后仍要认得出。
  assert.equal(
    await findBySpec(dir, 'github:LaplaceYoung/dsh-qq2006#abc1234'),
    '@dsh-external/dsh-qq2006',
  )
  assert.equal(await findBySpec(dir, 'github:someone/unrelated'), undefined)
})
