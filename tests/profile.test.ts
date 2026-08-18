/** profile patch 层的读写。改的是用户自己的配置文件，所以每条保证都要有测试盯着。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRow, listInstalled, profileDirOf, removeRow, rowIdOf } from '../src/profile.ts'

/** 一个空的临时 profile 目录。 */
async function makeProfile(patch?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'skin-market-'))
  if (patch !== undefined) await writeFile(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  return dir
}

const patchOf = (dir: string): Promise<string> => readFile(join(dir, 'cordis.patch.yml'), 'utf8')

test('patch 文件不存在时，第一次安装会建出来', async () => {
  const dir = await makeProfile()
  assert.equal(await addRow(dir, 'dsh-cool-skin'), true)
  const text = await patchOf(dir)
  assert.match(text, /id: skin:dsh-cool-skin/)
  assert.match(text, /name: dsh-cool-skin/)
})

test('重复安装是幂等的，不会写出第二行', async () => {
  const dir = await makeProfile()
  await addRow(dir, 'dsh-cool-skin')
  assert.equal(await addRow(dir, 'dsh-cool-skin'), false)
  const rows = (await patchOf(dir)).match(/id: skin:dsh-cool-skin/g) ?? []
  assert.equal(rows.length, 1)
})

test('用户自己写的行和注释原样保留', async () => {
  const original = [
    '# 我自己的配置，别动',
    '- insert:',
    '    - id: my-own-plugin',
    '      name: some-plugin',
    '',
  ].join('\n')
  const dir = await makeProfile(original)

  await addRow(dir, 'dsh-cool-skin')
  const afterAdd = await patchOf(dir)
  assert.match(afterAdd, /# 我自己的配置，别动/)
  assert.match(afterAdd, /id: my-own-plugin/)

  // 卸载只摘自己那行，用户的行和注释都还在。
  assert.equal(await removeRow(dir, 'dsh-cool-skin'), true)
  const afterRemove = await patchOf(dir)
  assert.match(afterRemove, /# 我自己的配置，别动/)
  assert.match(afterRemove, /id: my-own-plugin/)
  assert.doesNotMatch(afterRemove, /skin:dsh-cool-skin/)
})

test('patch 文件不是条目数组时报错，绝不覆盖用户的文件', async () => {
  const dir = await makeProfile('someKey: 请不要把我变成数组\n')
  await assert.rejects(() => addRow(dir, 'dsh-cool-skin'), /不是 patch 条目数组/)
  // 关键是原文件没被动过。
  assert.equal(await patchOf(dir), 'someKey: 请不要把我变成数组\n')
})

test('已安装列表只认市场装的行，不把用户自己的插件算进来', async () => {
  const dir = await makeProfile([
    '- insert:',
    '    - id: my-own-plugin',
    '      name: some-plugin',
    '',
  ].join('\n'))
  await addRow(dir, 'dsh-cool-skin')

  const installed = await listInstalled(dir)
  assert.equal(installed.length, 1)
  assert.equal(installed[0]?.packageName, 'dsh-cool-skin')
  assert.equal(installed[0]?.rowId, rowIdOf('dsh-cool-skin'))
})

test('已安装列表带上 profile 里记录的依赖 spec', async () => {
  const dir = await makeProfile()
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-cool-skin': '^1.2.0' } }),
    'utf8',
  )
  await addRow(dir, 'dsh-cool-skin')
  const installed = await listInstalled(dir)
  assert.equal(installed[0]?.spec, '^1.2.0')
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
