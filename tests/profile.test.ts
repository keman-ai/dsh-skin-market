/** Reading and writing the profile patch layer. This edits the user's own config file, so every guarantee needs a test watching it. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyBundlePatch, findBySpec, listInstalled, profileDirOf, removeRow } from '../src/profile.ts'

/** A temporary profile directory. */
async function makeProfile(patch?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'skin-market-'))
  if (patch !== undefined) await writeFile(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  return dir
}

/**
 * Create an installed skin package inside a profile.
 * @param dir - The profile directory.
 * @param name - Package name, optionally scoped.
 * @param patch - Contents of that package's cordis.patch.yml; omit it to declare no dsh.bundle.
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

/** The layer shape skins really use: a top-level row, not an insert wrapper. */
const QQ_PATCH = `# mount the QQ2006 skin
- id: ui-skin-qq2006
  name: '@dsh-external/dsh-qq2006'
`

test('inlines the layer the package declares verbatim — id and name come from the author, never guessed', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)

  assert.equal((await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')).rows, 1)
  const text = await patchOf(dir)
  // The package is scoped and the row id is the author's ui-skin-qq2006 — neither may be ours.
  assert.match(text, /id: ui-skin-qq2006/)
  assert.match(text, /@dsh-external\/dsh-qq2006/)
})

test('an author using the insert shape is preserved as written', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'dsh-other-skin', '- insert:\n    - id: other\n      name: dsh-other-skin\n')

  await applyBundlePatch(dir, 'dsh-other-skin')
  assert.match(await patchOf(dir), /insert:/)
})

test('every row is carried over when one package contributes several', async () => {
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

test('repeat installs are idempotent and carry nothing twice', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')
  assert.equal((await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')).rows, 0)
  assert.equal((await patchOf(dir)).match(/id: ui-skin-qq2006/g)?.length, 1)
})

test('a package with no dsh.bundle declaration is not a skin and is refused', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'just-a-library')
  await assert.rejects(
    () => applyBundlePatch(dir, 'just-a-library'),
    /declares no dsh.bundle.patch/,
  )
})

test('rows and comments the user wrote are preserved; uninstall removes only what we marked', async () => {
  const original = [
    '# my own config, leave it alone',
    '- insert:',
    '    - id: my-own-plugin',
    '      name: some-plugin',
    '',
  ].join('\n')
  const dir = await makeProfile(original)
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)

  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')
  const afterAdd = await patchOf(dir)
  assert.match(afterAdd, /# my own config, leave it alone/)
  assert.match(afterAdd, /id: my-own-plugin/)

  assert.equal(await removeRow(dir, '@dsh-external/dsh-qq2006'), true)
  const afterRemove = await patchOf(dir)
  assert.match(afterRemove, /# my own config, leave it alone/)
  assert.match(afterRemove, /id: my-own-plugin/)
  assert.doesNotMatch(afterRemove, /ui-skin-qq2006/)
})

test('the installed list keys off ownership markers and never counts the user\'s own plugins', async () => {
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

test('the installed list carries the dependency spec recorded in the profile, which the UI uses to decide what is installed', async () => {
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

test('a patch file that is not an array of entries raises an error and never overwrites the user file', async () => {
  const dir = await makeProfile('someKey: please do not turn me into an array\n')
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await assert.rejects(() => applyBundlePatch(dir, '@dsh-external/dsh-qq2006'), /is not an array of patch entries/)
  assert.equal(await patchOf(dir), 'someKey: please do not turn me into an array\n')
})

test('uninstalling a package that was never installed returns false rather than throwing', async () => {
  const dir = await makeProfile()
  assert.equal(await removeRow(dir, 'never-installed'), false)
})

test('ctx.baseUrl resolves to a directory whether it is a file:// URL or a bare path', () => {
  assert.equal(profileDirOf('/Users/x/.dsh/profiles/web'), '/Users/x/.dsh/profiles/web')
  assert.equal(profileDirOf('file:///Users/x/.dsh/profiles/web'), '/Users/x/.dsh/profiles/web')
  assert.equal(profileDirOf(undefined), undefined)
  assert.equal(profileDirOf(''), undefined)
})

test('the "mount myself" written as "edit a row" mistake is caught — otherwise it installs and silently does nothing', async () => {
  const dir = await makeProfile()
  // A real shape seen in the wild: no insert, a new id, and its own name — applyEntryPatches
  // skips it because that id does not exist, and the official bundles route fails the same way.
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)

  const applied = await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')
  assert.equal(applied.rows, 1)
  assert.equal(applied.repaired, 1)

  const text = await patchOf(dir)
  assert.match(text, /insert:/)
  // Repaired rows get our uniform naming, and the author's never-effective id stays out of the
  // config while being recorded in a comment for traceability.
  assert.match(text, /id: skin:@dsh-external\/dsh-qq2006/)
  assert.doesNotMatch(text, /^\s*- id: ui-skin-qq2006/m)
  assert.match(text, /repaired, original id: ui-skin-qq2006/)
})

test('a freshly created patch file is block YAML, not flow style crammed onto one line', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')

  const text = await patchOf(dir)
  assert.doesNotMatch(text, /^\[/)
  assert.match(text, /^- insert:$/m)
})

test('written rows read back verbatim — a colon inside an id does not derail YAML parsing', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, '@dsh-external/dsh-qq2006', QQ_PATCH)
  await applyBundlePatch(dir, '@dsh-external/dsh-qq2006')

  const { parse } = await import('yaml')
  const parsed = parse(await patchOf(dir)) as { insert: { id: string; name: string }[] }[]
  assert.equal(parsed[0]?.insert[0]?.id, 'skin:@dsh-external/dsh-qq2006')
  assert.equal(parsed[0]?.insert[0]?.name, '@dsh-external/dsh-qq2006')
})

test('ids do not collide when several rows of one package are repaired', async () => {
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

test('rows the author wrote correctly keep even their id — rows of one package may reference each other by id', async () => {
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
  // Both rows must keep author-row, or the second one's override lands nowhere.
  assert.equal(text.match(/author-row/g)?.length, 2)
  assert.doesNotMatch(text, /skin:dsh-linked/)
})

test('genuine override patches are untouched — the test is that name must be this very package', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'dsh-tweaker', [
    '# overriding someone else\'s row: name points at another package',
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

test('an override patch with no name is left alone too', async () => {
  const dir = await makeProfile()
  await fakePackage(dir, 'dsh-tweaker2', '- id: agent-default-model\n  config:\n    provider: y\n')
  const applied = await applyBundlePatch(dir, 'dsh-tweaker2')
  assert.equal(applied.repaired, 0)
})

test('look up a package name by spec — how we identify what is installed when the dependency is already there', async () => {
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
  // pnpm sometimes appends a commit, and it must still be recognised once # is dropped.
  assert.equal(
    await findBySpec(dir, 'github:LaplaceYoung/dsh-qq2006#abc1234'),
    '@dsh-external/dsh-qq2006',
  )
  assert.equal(await findBySpec(dir, 'github:someone/unrelated'), undefined)
})
