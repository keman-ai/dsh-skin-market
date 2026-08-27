/**
 * Reading and writing the profile directory: locating it, listing what is installed, and adding to or removing from the user patch layer.
 *
 * Why write the profile's `cordis.patch.yml` (the user layer) rather than
 * `dsh.profile.bundles` (what the `dsh plugin` CLI uses): app-boot's watchUserPatches
 * watches the user layer continuously, so within about a second the Loader tree
 * transactionally recomposes and the new plugin's host half mounts — no process restart.
 * bundles is not watched, and changing it requires one.
 *
 * Key constraint: **never compose the plugin row ourselves.** A skin package declares its
 * own layer in `dsh.bundle.patch`, and its shape is the author's choice (an `insert` of new
 * rows, or a config override of an existing row by id). We inline that file's entries into
 * the user layer verbatim, adding only an ownership comment so uninstall can remove exactly
 * those rows.
 */

import { readFile, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseDocument, YAMLSeq, type Document } from 'yaml'
import type { InstalledSkin } from './types.ts'

/** Ownership marker for inlined entries, written as a leading comment on each top-level entry. */
export const OWNER_TAG = 'skin-market:'

/** Marker text for a given package. */
const tagOf = (packageName: string): string => `${OWNER_TAG}${packageName}`

/**
 * Resolve ctx.baseUrl to a local directory. It may be a file:// URL or already a path.
 * @param baseUrl - The config-tree anchor.
 * @returns Absolute profile directory, or undefined when it cannot be resolved.
 */
export function profileDirOf(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined || baseUrl === '') return undefined
  try {
    return baseUrl.startsWith('file:') ? fileURLToPath(baseUrl) : baseUrl
  } catch {
    return undefined
  }
}

/** Is the directory writable? Ask before installing, not halfway through. */
export async function isWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Read the profile's patch file, returning an empty document when absent. */
async function loadPatch(profileDir: string): Promise<{ file: string; doc: Document }> {
  const file = join(profileDir, 'cordis.patch.yml')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  // parseDocument preserves comments and formatting: this is the user's own config file and we merely add rows.
  const doc = parseDocument(text === '' ? '[]' : text)
  // By convention the patch file is an array of entries. If it is not, we do not understand
  // this config — raise an error rather than overwriting the user's file with an empty array.
  if (!(doc.contents instanceof YAMLSeq)) {
    throw new Error(`${file} is not an array of patch entries; the market leaves it alone rather than overwrite your config`)
  }
  // A sequence parsed from '[]' is flow style, so added rows would be crammed onto one line
  // as `[ {...} ]`. This is a config file people read and edit, so a fresh one must be
  // ordinary block YAML.
  if (text === '') doc.contents.flow = false
  return { file, doc }
}

/**
 * The ownership marker on a top-level entry — the comment we wrote.
 * Extra explanation may follow it, so take only the first word.
 */
function ownerOf(item: unknown): string | undefined {
  const comment = (item as { commentBefore?: string | null } | null)?.commentBefore
  if (typeof comment !== 'string') return undefined
  for (const line of comment.split('\n')) {
    const at = line.indexOf(OWNER_TAG)
    if (at < 0) continue
    const owner = line.slice(at + OWNER_TAG.length).trim().split(/\s+/)[0]
    if (owner !== undefined && owner !== '') return owner
  }
  return undefined
}

/**
 * The id of a repaired row: named by us, not the author's id that never took effect.
 * The full package name guarantees uniqueness (same-named packages under two scopes cannot
 * collide), with an ordinal appended when one package contributes several rows.
 * @param packageName - The package providing this row.
 * @param ordinal - Which repaired row of that package this is, from 0.
 * @returns A row id in the uniform format.
 */
const repairedIdOf = (packageName: string, ordinal: number): string => (
  ordinal === 0 ? `skin:${packageName}` : `skin:${packageName}#${ordinal + 1}`
)

/**
 * Read the bundle patch file an installed package declares.
 * @param profileDir - The profile directory.
 * @param packageName - The package name (must be the real one, never guessed from the spec).
 * @param packageDir - The package's actual directory; always pass it when pnpm can tell you.
 * @returns The parsed patch document.
 * @throws When the package is missing, declares no dsh.bundle, or the patch file is unreadable.
 */
async function loadBundlePatch(
  profileDir: string, packageName: string, packageDir?: string,
): Promise<Document> {
  const manifestPath = packageDir !== undefined
    ? join(packageDir, 'package.json')
    : resolveManifest(profileDir, packageName)

  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    // No package.json at the repo root — most likely a multi-skin repo keeping each skin in a subdirectory.
    throw new Error(
      `${packageName} installed into a directory with no package.json. `
      + 'This skin most likely lives in a subdirectory of its repository, and pnpm cannot '
      + 'install from a subdirectory of a git repo (only a branch or commit may follow `#`). '
      + "Please install it manually, following the author's instructions on the market page.",
    )
  }
  const manifest = JSON.parse(raw) as { dsh?: { bundle?: { patch?: string } } }
  const relative = manifest.dsh?.bundle?.patch
  if (relative === undefined) {
    throw new Error(
      `${packageName} declares no dsh.bundle.patch — it is a plain dependency, not a mountable skin bundle`,
    )
  }

  const patchPath = resolve(dirname(manifestPath), relative)
  const doc = parseDocument(await readFile(patchPath, 'utf8'))
  if (!(doc.contents instanceof YAMLSeq)) {
    throw new Error(`${relative} in ${packageName} is not an array of patch entries`)
  }
  return doc
}

/**
 * Without a path from pnpm, fall back to finding the manifest ourselves.
 *
 * Joining `node_modules/<name>` is unreliable: pnpm's isolated layout keeps the real files
 * in `.pnpm/<hash>/node_modules/<name>` with only a symlink at the top level, and nothing
 * guarantees when that link appears — reading right after install can ENOENT. So try Node's
 * resolution algorithm first.
 * @param profileDir - The profile directory.
 * @param packageName - The package name.
 * @returns The package.json path (which may not exist; the caller's read reports that).
 */
function resolveManifest(profileDir: string, packageName: string): string {
  const require = createRequire(join(profileDir, 'noop.js'))
  try {
    return require.resolve(`${packageName}/package.json`)
  } catch {
    // Packages whose exports do not expose package.json land here.
    return join(profileDir, 'node_modules', packageName, 'package.json')
  }
}

/**
 * List the skins the market installed. The data comes from the local profile and touches no
 * network, so this works offline.
 * @param profileDir - The profile directory.
 * @returns Installed skins, sorted by package name.
 */
export async function listInstalled(profileDir: string): Promise<InstalledSkin[]> {
  const { doc } = await loadPatch(profileDir)
  const deps = await readDependencies(profileDir)
  const seen = new Map<string, { rows: number; disabled: boolean }>()

  for (const item of (doc.contents as YAMLSeq).items) {
    const owner = ownerOf(item)
    if (owner === undefined) continue
    const previous = seen.get(owner) ?? { rows: 0, disabled: true }
    const disabled = (item as { get?: (key: string) => unknown }).get?.('disabled') === true
    // One package may contribute several rows; the skin counts as enabled if any row is.
    seen.set(owner, { rows: previous.rows + 1, disabled: previous.disabled && disabled })
  }

  const out: InstalledSkin[] = []
  for (const [packageName, state] of seen) {
    out.push({
      packageName,
      rowId: tagOf(packageName),
      disabled: state.disabled,
      ...(deps[packageName] !== undefined ? { spec: deps[packageName] } : {}),
      ...(await readVersion(profileDir, packageName)),
      ...(await readThemeId(profileDir, packageName)),
    })
  }
  return out.sort((a, b) => a.packageName.localeCompare(b.packageName))
}

/** The profile package.json's dependencies. */
export async function readDependencies(profileDir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(profileDir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> }
    return parsed.dependencies ?? {}
  } catch {
    return {}
  }
}

/**
 * Look up a package name in the profile's dependencies by install spec.
 *
 * For the two "the dependency is already there" cases: a repeat install, and the residue of
 * a failed `pnpm remove` during uninstall (patch row gone, dependency still present). pnpm
 * sometimes normalises a git spec and appends a commit, so when an exact match fails,
 * compare again on the part before `#`.
 * @param profileDir - The profile directory.
 * @param spec - The install spec from the catalog.
 * @returns The matching package name, or undefined.
 */
export async function findBySpec(profileDir: string, spec: string): Promise<string | undefined> {
  const deps = Object.entries(await readDependencies(profileDir))
  const exact = deps.find(([, value]) => value === spec)
  if (exact !== undefined) return exact[0]
  const bare = spec.split('#')[0]
  return deps.find(([, value]) => value.split('#')[0] === bare)?.[0]
}

/** The installed package's actual version. If unreadable, omit it rather than guess. */
async function readVersion(profileDir: string, packageName: string): Promise<{ version?: string }> {
  try {
    const raw = await readFile(join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version === undefined ? {} : { version: parsed.version }
  } catch {
    return {}
  }
}

/**
 * Resolve the absolute path of an installed skin's preview image.
 *
 * 🔴 The path comes from the package's own skin.json, but <b>the resolved result must be
 * verified to stay inside the package directory</b> — that field is written by the package
 * author, and a value like `../../..` would turn this route into arbitrary file read.
 * Validation compares prefixes after resolve, not by searching for `..` in the string
 * (encodings such as `%2e%2e` slip past that).
 *
 * @param profileDir - The profile directory.
 * @param packageName - The package name; the caller must first confirm it is installed.
 * @returns The absolute preview path, or undefined when absent or out of bounds.
 */
export async function resolveIconPath(
  profileDir: string, packageName: string,
): Promise<string | undefined> {
  // Only npm-legal package names, blocking `../`-style path injection
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(packageName)) return undefined
  const packageDir = join(profileDir, 'node_modules', packageName)
  try {
    const skin = JSON.parse(
      await readFile(join(packageDir, 'skin.json'), 'utf8'),
    ) as { preview?: Record<string, string> }
    const candidates = Object.values(skin.preview ?? {}).filter(v => typeof v === 'string')
    for (const relative of candidates) {
      const full = resolve(packageDir, relative)
      // Must remain inside the package directory: an author writing ../../ still cannot read elsewhere
      if (!full.startsWith(resolve(packageDir) + '/')) continue
      try {
        await access(full, constants.R_OK)
        return full
      } catch {
        // Declared but missing — try the next one
      }
    }
  } catch {
    // No skin.json, or unreadable — it simply has no icon
  }
  return undefined
}

/**
 * Read the theme id a package registers from its skin.json.
 *
 * A skin's three ids (skin.json#id, THEME_ID, and the patch's insert.id) must agree by
 * convention, so reading skin.json is enough. A package without that file — not a skin built
 * to spec — returns nothing, and the UI simply shows no enable button, rather than guessing
 * an id for setTheme that fails to switch with no diagnosable reason.
 * @param profileDir - The profile directory.
 * @param packageName - The package name.
 * @returns The theme id, or an empty object when unreadable.
 */
async function readThemeId(profileDir: string, packageName: string): Promise<{ themeId?: string }> {
  try {
    const raw = await readFile(join(profileDir, 'node_modules', packageName, 'skin.json'), 'utf8')
    const parsed = JSON.parse(raw) as { id?: string }
    return typeof parsed.id === 'string' && parsed.id !== '' ? { themeId: parsed.id } : {}
  } catch {
    return {}
  }
}

/**
 * Inline the patch layer an installed skin package declares into the user layer.
 *
 * Entries are carried over verbatim, with only an ownership comment attached — whether the
 * author wrote an `insert` or an override by id, the semantics are preserved. Idempotent:
 * already-carried entries are not carried again.
 * @param profileDir - The profile directory.
 * @param packageName - The real package name, read from the install result rather than guessed.
 * @param packageDir - The package's actual directory; always pass it when pnpm can tell you.
 * @returns How many entries were carried and how many of them were repaired; rows: 0 when already present.
 */
export async function applyBundlePatch(
  profileDir: string, packageName: string, packageDir?: string,
): Promise<{ rows: number; repaired: number }> {
  const { file, doc } = await loadPatch(profileDir)
  const seq = doc.contents as YAMLSeq
  if (seq.items.some(item => ownerOf(item) === packageName)) return { rows: 0, repaired: 0 }

  const bundle = await loadBundlePatch(profileDir, packageName, packageDir)
  const rows = (bundle.contents as YAMLSeq).items
  if (rows.length === 0) {
    throw new Error(`${packageName}'s bundle patch is empty — there is no plugin row to mount`)
  }

  let repaired = 0
  for (const row of rows) {
    // Round-trip through JSON onto this document: inserting a node across documents drags along the source document's anchors and formatting state.
    const plain = JSON.parse(JSON.stringify(row)) as Record<string, unknown>
    const fixed = repairSelfMount(plain, packageName, repaired)
    const note = fixed === plain ? '' : ` (repaired, original id: ${String(plain.id)})`
    if (fixed !== plain) repaired += 1

    const node = doc.createNode(fixed) as { commentBefore?: string | null }
    node.commentBefore = ` ${tagOf(packageName)}${note}`
    seq.add(node)
  }

  await writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8')
  return { rows: rows.length, repaired }
}

/**
 * Catch a common bundle-patch mistake: writing "mount myself" as "edit a row".
 *
 * The patch semantics are: `{insert: [...]}` appends new rows, while `{id, ...}` **overrides
 * an existing row by id**, and a missing id only warns and skips (applyEntryPatches in
 * vendor/include). So `- id: ui-skin-xxx / name: '<its own package name>'` is a no-op in any
 * layer — including the official `dsh.profile.bundles` route, where it installs and silently
 * does nothing. Skins in the wild are written this way.
 *
 * The test is deliberately narrow, matching only the obvious "it meant to mount itself" case:
 * no insert, an id present, and a name that is this very package. Genuine override patches
 * (name pointing at another package, or no name at all) are untouched.
 *
 * While repairing, the row id is also switched to our uniform naming: the author's id never
 * took effect in the tree, so no other row can reference it, making the change safe — and it
 * buys instant recognition of which rows the market installed. Rows the author wrote
 * correctly keep even their id, since several rows of one package may reference each other by id.
 * @param row - One row from the bundle patch.
 * @param packageName - The package providing this row.
 * @param ordinal - How many rows of that package have already been repaired.
 * @returns The renamed and wrapped row when repair is needed, otherwise the input unchanged.
 */
function repairSelfMount(
  row: Record<string, unknown>, packageName: string, ordinal: number,
): Record<string, unknown> {
  if (row.insert !== undefined) return row
  if (typeof row.id !== 'string' || row.name !== packageName) return row
  return { insert: [{ ...row, id: repairedIdOf(packageName, ordinal) }] }
}

/**
 * Remove every entry a package inlined. Only ownership comments count; rows the user wrote
 * are never touched.
 * @param profileDir - The profile directory.
 * @param packageName - The package name.
 * @returns Whether anything was actually removed.
 */
export async function removeRow(profileDir: string, packageName: string): Promise<boolean> {
  const { file, doc } = await loadPatch(profileDir)
  const seq = doc.contents as YAMLSeq
  const before = seq.items.length
  seq.items = seq.items.filter(item => ownerOf(item) !== packageName)

  if (seq.items.length === before) return false
  await writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8')
  return true
}
