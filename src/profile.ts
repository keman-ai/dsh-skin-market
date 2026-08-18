/**
 * profile 目录的读写：定位、已装清单、用户 patch 层的增删。
 *
 * 为什么写 profile 的 `cordis.patch.yml`（用户层）而不是 `dsh.profile.bundles`
 * （`dsh plugin` CLI 用的那份）：用户层被 app-boot 的 watchUserPatches 持续监视，
 * 写完约 1 秒内 Loader 树事务式热重组，新插件的 host 半直接挂上，不用重启进程。
 * bundles 不在监视范围内，改它就得重启。
 *
 * 关键约束：**不自己拼插件行**。皮肤包在 `dsh.bundle.patch` 里声明了自己那一层，
 * 形状由作者决定（可能是 `insert` 新行，也可能是按 id 覆盖既有行的 config）。
 * 我们把那个文件的条目原样内联进用户层，只额外挂一条注释标记归属，用于卸载时精确摘除。
 */

import { readFile, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseDocument, YAMLSeq, type Document } from 'yaml'
import type { InstalledSkin } from './types.ts'

/** 内联条目的归属标记，写在每个顶层条目的前置注释里。 */
export const OWNER_TAG = 'skin-market:'

/** 某个包的标记文本。 */
const tagOf = (packageName: string): string => `${OWNER_TAG}${packageName}`

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
  // 从 '[]' 解析出来的序列是 flow 风格，往里加行会写成挤作一行的 `[ {...} ]`。
  // 这是用户要读要改的配置文件，新建时也得是正常的块状 YAML。
  if (text === '') doc.contents.flow = false
  return { file, doc }
}

/**
 * 顶层条目上的归属标记（我们写进去的那条注释）。
 * 标记后面可能跟着补充说明，所以只取第一个词。
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
 * 修正后那一行的 id：由我们命名，不沿用作者那个从没生效过的 id。
 * 用完整包名保证唯一（两个 scope 下的同名包不会撞），同包多行时追加序号。
 * @param packageName - 提供这行的包。
 * @param ordinal - 该包第几个被修正的行，从 0 起。
 * @returns 统一格式的行 id。
 */
const repairedIdOf = (packageName: string, ordinal: number): string => (
  ordinal === 0 ? `skin:${packageName}` : `skin:${packageName}#${ordinal + 1}`
)

/**
 * 读一个已安装包声明的 bundle patch 文件。
 * @param profileDir - profile 目录。
 * @param packageName - 包名（必须是真实包名，不是从 spec 猜的）。
 * @returns patch 文件路径与解析后的文档。
 * @throws 包不存在、没声明 dsh.bundle、或 patch 文件读不出来。
 */
async function loadBundlePatch(profileDir: string, packageName: string): Promise<Document> {
  const require = createRequire(join(profileDir, 'noop.js'))
  let manifestPath: string
  try {
    manifestPath = require.resolve(`${packageName}/package.json`)
  } catch {
    // 退一步用目录直拼：有些包的 exports 不暴露 package.json。
    manifestPath = join(profileDir, 'node_modules', packageName, 'package.json')
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const relative = manifest.dsh?.bundle?.patch
  if (relative === undefined) {
    throw new Error(
      `${packageName} 没有声明 dsh.bundle.patch —— 它是一个普通依赖，不是能挂载的皮肤组合包`,
    )
  }

  const patchPath = resolve(dirname(manifestPath), relative)
  const doc = parseDocument(await readFile(patchPath, 'utf8'))
  if (!(doc.contents instanceof YAMLSeq)) {
    throw new Error(`${packageName} 的 ${relative} 不是 patch 条目数组`)
  }
  return doc
}

/**
 * 列出市场装过的皮肤。数据来自本机 profile，不碰网络 —— 断网也能管。
 * @param profileDir - profile 目录。
 * @returns 已装皮肤，按包名排序。
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
    // 一个包可能贡献多行；只要有一行是启用的，这个皮肤就算启用。
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
    })
  }
  return out.sort((a, b) => a.packageName.localeCompare(b.packageName))
}

/** profile package.json 的 dependencies。 */
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
 * 在 profile 的依赖里按安装 spec 反查包名。
 *
 * 用于两种「依赖已经在了」的局面：重复安装，以及卸载时 `pnpm remove` 失败留下的
 * 残留（patch 行已摘、依赖还在）。pnpm 有时会把 git spec 规范化并缀上 commit，
 * 所以精确比不中时再按 `#` 之前的部分比一次。
 * @param profileDir - profile 目录。
 * @param spec - 目录给出的安装 spec。
 * @returns 匹配到的包名；没有则 undefined。
 */
export async function findBySpec(profileDir: string, spec: string): Promise<string | undefined> {
  const deps = Object.entries(await readDependencies(profileDir))
  const exact = deps.find(([, value]) => value === spec)
  if (exact !== undefined) return exact[0]
  const bare = spec.split('#')[0]
  return deps.find(([, value]) => value.split('#')[0] === bare)?.[0]
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
 * 把一个已安装皮肤包声明的 patch 层内联进用户层。
 *
 * 逐条原样搬运，只给每条挂一个归属注释 —— 作者写的是 `insert` 还是按 id 覆盖，
 * 语义都保持不变。已经搬过就不重复搬（幂等）。
 * @param profileDir - profile 目录。
 * @param packageName - 真实包名（从安装结果读出来的，不是猜的）。
 * @returns 搬进去的条目数与其中被修正的行数；已经在了返回 rows: 0。
 */
export async function applyBundlePatch(
  profileDir: string, packageName: string,
): Promise<{ rows: number; repaired: number }> {
  const { file, doc } = await loadPatch(profileDir)
  const seq = doc.contents as YAMLSeq
  if (seq.items.some(item => ownerOf(item) === packageName)) return { rows: 0, repaired: 0 }

  const bundle = await loadBundlePatch(profileDir, packageName)
  const rows = (bundle.contents as YAMLSeq).items
  if (rows.length === 0) {
    throw new Error(`${packageName} 的 bundle patch 是空的，没有可挂载的插件行`)
  }

  let repaired = 0
  for (const row of rows) {
    // 经 JSON 往返落到本文档上：跨文档直接塞节点会带着原文档的锚点与格式状态。
    const plain = JSON.parse(JSON.stringify(row)) as Record<string, unknown>
    const fixed = repairSelfMount(plain, packageName, repaired)
    const note = fixed === plain ? '' : ` （已修正，原 id: ${String(plain.id)}）`
    if (fixed !== plain) repaired += 1

    const node = doc.createNode(fixed) as { commentBefore?: string | null }
    node.commentBefore = ` ${tagOf(packageName)}${note}`
    seq.add(node)
  }

  await writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8')
  return { rows: rows.length, repaired }
}

/**
 * 接住一种常见的 bundle patch 笔误：把「挂载我自己」写成了「改一行」。
 *
 * patch 的语义是：`{insert: [...]}` 追加新行，而 `{id, ...}` 是**按 id 覆盖已有行**，
 * 找不到那个 id 就只 warn 一句然后跳过（vendor/include 的 applyEntryPatches）。
 * 于是 `- id: ui-skin-xxx / name: '<自己的包名>'` 这种写法在任何层里都是空操作 ——
 * 包括走官方 `dsh.profile.bundles` 时，装了也静默不生效。社区里已经有皮肤这么写。
 *
 * 判据收得很紧，只认「它显然是想挂载自己」这一种：没有 insert、有 id、且 name
 * 正是这个包自己。真正的覆盖型 patch（name 指向别的包，或压根不写 name）不受影响。
 *
 * 修正时顺手把行 id 换成我们统一命名的那个：作者原来的 id 从没在树里生效过，
 * 也就不可能有别的行按它引用，换掉是安全的，换来的是 profile 里一眼能认出
 * 哪些行是市场装的。作者写对的行则连 id 都不碰 —— 同包多行之间可能靠 id 互相引用。
 * @param row - bundle patch 里的一行。
 * @param packageName - 提供这行的包。
 * @param ordinal - 该包此前已修正过几行。
 * @returns 需要修正时返回改名并包装后的行，否则原样返回入参。
 */
function repairSelfMount(
  row: Record<string, unknown>, packageName: string, ordinal: number,
): Record<string, unknown> {
  if (row.insert !== undefined) return row
  if (typeof row.id !== 'string' || row.name !== packageName) return row
  return { insert: [{ ...row, id: repairedIdOf(packageName, ordinal) }] }
}

/**
 * 摘掉某个包内联进来的所有条目。只认归属注释，用户自己写的行一律不碰。
 * @param profileDir - profile 目录。
 * @param packageName - 包名。
 * @returns 是否真的删掉了。
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
