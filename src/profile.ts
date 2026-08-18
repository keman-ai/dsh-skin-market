/**
 * profile 目录的读写：定位、已装清单、用户 patch 层的增删。
 *
 * 为什么写 profile 的 `cordis.patch.yml`（用户层）而不是 `dsh.profile.bundles`
 * （`dsh plugin` CLI 用的那份）：用户层被 app-boot 的 watchUserPatches 持续监视，
 * 写完约 1 秒内 Loader 树事务式热重组，新插件的 host 半直接挂上，不用重启进程。
 * bundles 不在监视范围内，改它就得重启。
 */

import { readFile, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument, YAMLSeq, YAMLMap, type Document } from 'yaml'
import type { InstalledSkin } from './types.ts'

/** patch 行 id 的前缀：标记这一行归市场管，卸载时才敢动它。 */
export const ROW_PREFIX = 'skin:'

/** 一行的 id。 */
export const rowIdOf = (packageName: string): string => `${ROW_PREFIX}${packageName}`

/**
 * 把 ctx.baseUrl 解成本地目录。它可能是 file:// URL，也可能已经是路径。
 * @param baseUrl - 配置树锚点。
 * @returns profile 目录绝对路径；解不出来时 undefined。
 */
export function profileDirOf(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined || baseUrl === '') return undefined
  try {
    return baseUrl.startsWith('file:') ? fileURLToPath(baseUrl) : baseUrl
  } catch {
    return undefined
  }
}

/** 目录可写吗 —— 装之前先问，别装到一半才失败。 */
export async function isWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** 读 profile 的 patch 文件；不存在时给一份空文档。 */
async function loadPatch(profileDir: string): Promise<{ file: string; doc: Document }> {
  const file = join(profileDir, 'cordis.patch.yml')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  // parseDocument 保留注释与原有格式：这是用户自己的配置文件，我们只是往里加行。
  const doc = parseDocument(text === '' ? '[]' : text)
  // patch 文件按约定是条目数组。不是的话说明这份配置我们看不懂 —— 报错，
  // 而不是拿一个空数组把用户的文件覆盖掉。
  if (!(doc.contents instanceof YAMLSeq)) {
    throw new Error(`${file} 不是 patch 条目数组，为避免覆盖你的配置，市场不动它`)
  }
  return { file, doc }
}

/** patch 文档里所有 insert 条目（每个 insert 可带多行）。 */
function insertRows(doc: Document): YAMLMap[] {
  const rows: YAMLMap[] = []
  const seq = doc.contents as YAMLSeq
  for (const item of seq.items) {
    if (!(item instanceof YAMLMap)) continue
    const insert = item.get('insert')
    if (!(insert instanceof YAMLSeq)) continue
    for (const row of insert.items) {
      if (row instanceof YAMLMap) rows.push(row)
    }
  }
  return rows
}

/**
 * 列出市场装过的皮肤。数据来自本机 profile，不碰网络 —— 断网也能管。
 * @param profileDir - profile 目录。
 * @returns 已装皮肤，按包名排序。
 */
export async function listInstalled(profileDir: string): Promise<InstalledSkin[]> {
  const { doc } = await loadPatch(profileDir)
  const deps = await readDependencies(profileDir)
  const out: InstalledSkin[] = []

  for (const row of insertRows(doc)) {
    const id = row.get('id')
    if (typeof id !== 'string' || !id.startsWith(ROW_PREFIX)) continue
    const name = row.get('name')
    const packageName = typeof name === 'string' ? name : id.slice(ROW_PREFIX.length)
    out.push({
      packageName,
      rowId: id,
      disabled: row.get('disabled') === true,
      ...(deps[packageName] !== undefined ? { spec: deps[packageName] } : {}),
      ...(await readVersion(profileDir, packageName)),
    })
  }
  return out.sort((a, b) => a.packageName.localeCompare(b.packageName))
}

/** profile package.json 的 dependencies。 */
async function readDependencies(profileDir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(profileDir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> }
    return parsed.dependencies ?? {}
  } catch {
    return {}
  }
}

/** 已装包的实际版本。读不到就不给，不猜。 */
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
 * 往用户 patch 层追加一行插件行。已经在了就什么都不做（幂等）。
 * @param profileDir - profile 目录。
 * @param packageName - 插件包名。
 * @returns 是否真的写了文件。
 */
export async function addRow(profileDir: string, packageName: string): Promise<boolean> {
  const { file, doc } = await loadPatch(profileDir)
  const id = rowIdOf(packageName)
  if (insertRows(doc).some(row => row.get('id') === id)) return false

  const row = doc.createNode({ id, name: packageName }) as YAMLMap
  const entry = doc.createNode({ insert: [] }) as YAMLMap
  ;(entry.get('insert') as YAMLSeq).add(row)
  ;(doc.contents as YAMLSeq).add(entry)

  await writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8')
  return true
}

/**
 * 从用户 patch 层移除市场装的那一行。只删 `skin:` 前缀的行，不碰用户自己写的。
 * @param profileDir - profile 目录。
 * @param packageName - 插件包名。
 * @returns 是否真的删掉了。
 */
export async function removeRow(profileDir: string, packageName: string): Promise<boolean> {
  const { file, doc } = await loadPatch(profileDir)
  const id = rowIdOf(packageName)
  const seq = doc.contents as YAMLSeq
  let removed = false

  for (let index = seq.items.length - 1; index >= 0; index -= 1) {
    const item = seq.items[index]
    if (!(item instanceof YAMLMap)) continue
    const insert = item.get('insert')
    if (!(insert instanceof YAMLSeq)) continue

    for (let at = insert.items.length - 1; at >= 0; at -= 1) {
      const row = insert.items[at]
      if (row instanceof YAMLMap && row.get('id') === id) {
        insert.items.splice(at, 1)
        removed = true
      }
    }
    // 该 insert 里的行被删光了，整个条目也就没有意义了。
    if (insert.items.length === 0) seq.items.splice(index, 1)
  }

  if (removed) await writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8')
  return removed
}
