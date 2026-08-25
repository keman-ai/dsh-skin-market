/**
 * 安装执行：pnpm 探测 → `pnpm add` → 写用户 patch 层 → 热重组。
 *
 * 事务化：先 pnpm，成功了才写 patch 行；写行失败就把包卸回去。半装状态比装失败更难查。
 */

import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import {
  applyBundlePatch, findBySpec, isWritable, listInstalled, readDependencies, removeRow,
} from './profile.ts'
import type { InstallEvent, InstallErrorCode } from './types.ts'

/**
 * 单次 pnpm 调用的上限。
 *
 * 🔴 原本是 5 分钟，实测不够：一个 68.7 MB 的皮肤仓库（作者把素材内嵌进 bundle，
 * 这在皮肤里并不罕见）走代理 clone，310 秒才刚拉到一半就被杀了，已下载的 132 MB
 * 全部作废，重试还得从头来。把"慢"当成"卡死"，代价比多等一会儿大得多。
 *
 * 20 分钟是留给最坏情况的兜底，不是期望值 —— 正常仓库几十秒就完事。真卡死了也还是
 * 会结束，不会永远转圈。
 */
const PNPM_TIMEOUT_MS = 20 * 60 * 1000

/**
 * 心跳间隔：git clone 期间 pnpm 完全静默（进度条是 TTY 动画，append-only 下
 * 那行 `Progress: resolved N` 拉完之前根本不动），界面看着就像死了。每隔这么久
 * 补一行"还活着"，让人知道该等而不是该重试 —— 重复点安装会起第二个 pnpm 抢同一条
 * 带宽，只会更慢，实测就撞上过。
 */
const HEARTBEAT_MS = 20 * 1000

/**
 * profile 目录自带 `pnpm-workspace.yaml`（`packages: ['.']`，dsh 初始化时写的），
 * 于是 pnpm 认为它是 workspace 根，`pnpm add` 会以 ERR_PNPM_ADDING_TO_ROOT 拒绝。
 * 这里加的正是"我确实要装到根"这个声明 —— 实测不加装不上。
 */
const ROOT_FLAG = '--ignore-workspace-root-check'

/**
 * 默认 reporter 在非 TTY 下几乎不输出（进度是 TTY 动画），于是 git 源那几十秒里
 * 界面只有一行 DeprecationWarning，看着像卡死。append-only 会逐行打进度。
 */
const REPORTER_FLAG = '--reporter=append-only'

/**
 * `pnpm add` 的参数。ROOT_FLAG 只有 add 认识 —— remove 带上它会以
 * "Unknown option" 直接失败，卸载功能就废了。
 */
const ADD_FLAGS = [ROOT_FLAG, REPORTER_FLAG]

/** `pnpm remove` 的参数。 */
const REMOVE_FLAGS = [REPORTER_FLAG]

/** 诊断与错误信息里回带的最近一次输出。 */
let lastLog = ''

/** 最近一次安装/卸载的完整输出。 */
export const getLastLog = (): string => lastLog

/** 一次 pnpm 调用的结果。 */
interface RunResult {
  readonly ok: boolean
  readonly output: string
}

/** 事件回调。 */
export type Emit = (event: InstallEvent) => void

/** 带错误码的失败，路由层据此决定回什么状态码和提示。 */
export class InstallFailure extends Error {
  readonly code: InstallErrorCode
  readonly detail: string | undefined

  constructor(code: InstallErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'InstallFailure'
    this.code = code
    this.detail = detail
  }
}

/**
 * 跑一条命令并把输出逐行回流。
 * @param command - 可执行文件。
 * @param args - 参数。
 * @param cwd - 工作目录。
 * @param emit - 行回调，可省略（只收集不回流）。
 * @returns 退出码与完整输出。
 */
function run(command: string, args: readonly string[], cwd: string, emit?: Emit): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd, env: process.env })
    let output = ''
    let settled = false

    const startedAt = Date.now()
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      output += `\n[超时] 命令超过 ${PNPM_TIMEOUT_MS / 60_000} 分钟未结束，已终止。`
        + '\n仓库过大或网络过慢时会走到这里；已下载的部分不会保留，重试将从头开始。'
    }, PNPM_TIMEOUT_MS)

    // 静默期的心跳。只在真的没有新输出时才补，有输出就让输出自己说话。
    let quietSince = Date.now()
    const heartbeat = setInterval(() => {
      if (settled || emit === undefined) return
      if (Date.now() - quietSince < HEARTBEAT_MS) return
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      emit({ type: 'log', line: `… 仍在下载，已用时 ${seconds}s（大仓库可能要几分钟，请勿重复点击）` })
      quietSince = Date.now()
    }, HEARTBEAT_MS)

    const consume = (chunk: Buffer): void => {
      const text = chunk.toString()
      output += text
      quietSince = Date.now()
      if (emit === undefined) return
      for (const line of text.split('\n')) {
        const trimmed = line.trimEnd()
        if (trimmed !== '') emit({ type: 'log', line: trimmed })
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(heartbeat)
      resolve({ ok, output })
    }
    child.on('error', (error) => {
      output += `\n${error.message}`
      finish(false)
    })
    child.on('close', code => { finish(code === 0) })
  })
}

/** pnpm 眼里 profile 的一个直接依赖。 */
interface InstalledPackage {
  readonly name: string
  readonly path: string
}

/**
 * 问 pnpm 要顶层依赖清单及其**实际路径**。
 *
 * 这是包名与包目录的权威来源：装完自己拼 `node_modules/<包名>` 会踩空
 * （isolated 布局下顶层只是符号链接，建立时机没有保证），而 pnpm 直接告诉我们
 * 实体在 `.pnpm/<hash>/node_modules/<包名>`。
 * @param profileDir - profile 目录。
 * @returns 包名到路径的映射；pnpm answer 不了时是空表，调用方各自兜底。
 */
async function inventory(profileDir: string): Promise<Map<string, InstalledPackage>> {
  const listed = await run('pnpm', ['list', '--json', '--depth=0'], profileDir)
  const out = new Map<string, InstalledPackage>()
  if (!listed.ok) return out
  try {
    const roots = JSON.parse(listed.output) as {
      dependencies?: Record<string, { path?: string }>
    }[]
    for (const root of roots) {
      for (const [name, info] of Object.entries(root.dependencies ?? {})) {
        if (typeof info.path === 'string') out.set(name, { name, path: info.path })
      }
    }
  } catch {
    // pnpm 在输出 JSON 之前打了别的东西，这次就当问不到。
  }
  return out
}

/**
 * pnpm 在不在，版本是多少。
 * @param cwd - 工作目录。
 * @returns 版本号；没装时 undefined。
 */
export async function pnpmVersion(cwd: string): Promise<string | undefined> {
  const result = await run('pnpm', ['--version'], cwd)
  return result.ok ? result.output.trim().split('\n').pop() : undefined
}

/**
 * 装进来的包，它声明的入口文件真的在吗。
 *
 * 这是最要紧的一道闸：git 源的 TypeScript 包要靠 `prepare` 构建出 lib/，而 pnpm
 * 默认拒绝执行构建脚本，于是包装上了、`lib/index.js` 却不存在。这种包一旦写进
 * 配置，Loader 在下次启动时会以 ERR_MODULE_NOT_FOUND 崩掉 —— **整个 dsh 起不来**，
 * 比皮肤不生效严重得多。所以挂载之前先验，缺文件就回滚。
 * @param packageDir - 包的实际目录。
 * @returns 缺失的入口文件列表；空数组表示可加载。
 */
async function missingEntries(packageDir: string): Promise<string[]> {
  let manifest: { main?: unknown; exports?: unknown }
  try {
    manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    return ['package.json']
  }

  // exports 可以是字符串、条件对象、或嵌套对象，统统摊平成候选相对路径。
  const candidates = new Set<string>()
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) candidates.add(value)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const nested of Object.values(value as Record<string, unknown>)) collect(nested)
    }
  }
  if (typeof manifest.main === 'string') candidates.add(manifest.main)
  collect(manifest.exports)

  const missing: string[] = []
  for (const relative of candidates) {
    // 通配导出（./src/*）指的是一族文件，逐个验没有意义。
    if (relative.includes('*')) continue
    try {
      await access(join(packageDir, relative), fsConstants.F_OK)
    } catch {
      missing.push(relative)
    }
  }
  return missing
}

/** pnpm 因为构建脚本没授权而没跑 prepare —— git 源装完会缺构建产物，加载必挂。 */
const blockedBuild = (output: string): boolean => (
  /ignored build scripts|approve-builds|allowBuilds/i.test(output)
)

/**
 * 装一个皮肤包。
 * @param profileDir - profile 目录（= ctx.baseUrl）。
 * @param spec - 安装 spec，必须已经过目录白名单校验。
 * @param packageName - 期望的包名，用于写 patch 行。
 * @param emit - 过程事件。
 * @throws InstallFailure 任一阶段失败。
 */
export async function install(
  profileDir: string, spec: string, emit: Emit,
): Promise<string> {
  if (!await isWritable(profileDir)) {
    throw new InstallFailure('PROFILE_UNRESOLVED', `profile 目录不可写：${profileDir}`)
  }
  // 判重按 spec，不按包名 —— 包名要装完才知道（见下）。这里只拦「装好且挂上了」的，
  // 「依赖在但没挂上」是可修复的不一致状态（卸载中途失败会留下），照常往下走。
  const installed = await listInstalled(profileDir)
  if (installed.some(row => row.spec === spec)) {
    throw new InstallFailure('ALREADY_INSTALLED', `${spec} 已经装过了`)
  }
  if (await pnpmVersion(profileDir) === undefined) {
    throw new InstallFailure(
      'PNPM_MISSING',
      'pnpm 不在 PATH 上。dsh 的插件安装本身就是转发 pnpm，所以必须先装它。',
      '试试 corepack enable pnpm，或 npm i -g pnpm',
    )
  }

  const before = new Set(Object.keys(await readDependencies(profileDir)))

  emit({ type: 'step', step: 'resolve' })
  emit({ type: 'log', line: `$ pnpm add ${spec}  (cwd: ${profileDir})` })
  emit({ type: 'step', step: 'download' })
  const added = await run('pnpm', ['add', ...ADD_FLAGS, spec], profileDir, emit)
  lastLog = added.output

  if (!added.ok) {
    if (blockedBuild(added.output)) throw buildBlocked(spec)
    throw new InstallFailure('PNPM_FAILED', `pnpm add ${spec} 失败`, tailOf(added.output))
  }

  /*
   * 真实包名只能从安装结果里读，不能从 spec 猜：`github:LaplaceYoung/dsh-qq2006`
   * 装出来的包名是 `@dsh-external/dsh-qq2006`。猜错的后果是往 patch 里写一个解析不到
   * 的模块名 —— pnpm 报成功，皮肤却静默地不生效。
   */
  const packages = await inventory(profileDir)
  const after = await readDependencies(profileDir)
  // 依赖已经在时 pnpm 只回一句 Already up to date，什么也不新增 —— 这时按 spec
  // 反查已有依赖，而不是把「装不上」的结论扣在一个其实装好了的包上。
  const packageName = [...packages.keys()].find(name => !before.has(name))
    ?? Object.keys(after).find(name => !before.has(name))
    ?? await findBySpec(profileDir, spec)
  if (packageName === undefined) {
    throw new InstallFailure(
      'PNPM_FAILED',
      'pnpm 报告成功，但 profile 依赖里找不到这个 spec，无法确定装上的包名',
      tailOf(added.output),
    )
  }
  emit({ type: 'log', line: `✓ 已安装 ${packageName}` })

  // 构建脚本被跳过时 pnpm 仍返回 0，但 git 源的包会缺构建产物 —— 装了也加载不了，
  // 所以这里当失败处理并回滚，而不是让用户刷新后看见一个坏掉的 dsh。
  if (blockedBuild(added.output)) {
    await run('pnpm', ['remove', ...REMOVE_FLAGS, packageName], profileDir)
    throw buildBlocked(packageName)
  }

  // 挂载之前先确认这个包真的能被 import：缺构建产物的包写进配置会让 dsh 起不来。
  const packageDir = packages.get(packageName)?.path
  if (packageDir !== undefined) {
    const missing = await missingEntries(packageDir)
    if (missing.length > 0) {
      await run('pnpm', ['remove', ...REMOVE_FLAGS, packageName], profileDir)
      throw new InstallFailure(
        'BUILD_SCRIPT_BLOCKED',
        `${packageName} 缺少它自己声明的入口文件，装上去会让 dsh 下次启动失败，已卸回去。`,
        `缺：${missing.join('、')}。这类包需要在安装时构建（prepare 脚本），`
        + '而 pnpm 默认不执行它。授权后可重试 —— 这等于允许该包的代码在你机器上执行，'
        + '且不在 agent 沙箱内。',
      )
    }
  }

  emit({ type: 'step', step: 'patch' })
  try {
    const applied = await applyBundlePatch(profileDir, packageName, packageDir)
    emit({ type: 'log', line: `✓ 已把 ${packageName} 声明的 ${applied.rows} 行 patch 内联进 profile` })
    if (applied.repaired > 0) {
      // 明确说出来：我们改动了作者写的东西，用户有权知道。
      emit({
        type: 'log',
        line: `⚠ 其中 ${applied.repaired} 行写成了「改一个不存在的行」，已按「挂载自己」修正 —— `
          + '否则这个皮肤装了也不会生效（用官方命令装同样如此，建议向作者反馈）',
      })
    }
  } catch (error) {
    // 挂不上就把包卸回去：宁可什么都没发生，也不要留下装了却没挂载的半吊子状态。
    await run('pnpm', ['remove', ...REMOVE_FLAGS, packageName], profileDir)
    const reason = error instanceof Error ? error.message : String(error)
    // 「装下来的根本不是一个皮肤组合包」是目录数据的问题，不是写配置失败，
    // 分开报错码，用户才知道该去找作者而不是查自己的磁盘权限。
    const notABundle = reason.includes('没有 package.json') || reason.includes('没有声明 dsh.bundle')
    throw new InstallFailure(
      notABundle ? 'NOT_A_BUNDLE' : 'PATCH_WRITE_FAILED',
      notABundle ? `${spec} 装不了，已把下载的包卸回去。` : `${packageName} 挂载失败，已把包卸回去。`,
      reason,
    )
  }

  emit({ type: 'step', step: 'compose' })
  emit({ type: 'log', line: '✓ Loader 树将在约 1 秒内热重组（未重启进程）' })
  emit({ type: 'done', packageName, needsReload: true })
  return packageName
}

/** 构建脚本被 pnpm 拦下的统一说法：这一条必须让用户明确点头，不能替他决定。 */
function buildBlocked(target: string): InstallFailure {
  return new InstallFailure(
    'BUILD_SCRIPT_BLOCKED',
    `${target} 需要在安装时运行构建脚本，pnpm 默认拒绝了。`,
    '同意即表示允许该包的代码在你的机器上执行，且不在 agent 沙箱内。'
    + '确认后我们会把 allowBuilds 写进 profile 的 pnpm-workspace.yaml 并重试。',
  )
}

/**
 * 卸一个皮肤包：先摘 patch 行（停止挂载），再删依赖。
 * @param profileDir - profile 目录。
 * @param packageName - 包名。
 * @param emit - 过程事件。
 * @throws InstallFailure 没装过或 pnpm 失败。
 */
export async function uninstall(profileDir: string, packageName: string, emit: Emit): Promise<void> {
  const installed = await listInstalled(profileDir)
  const deps = await readDependencies(profileDir)
  // 认「挂载行还在」或「依赖还在」任一即可：上一次卸载在 pnpm 那步失败过的话，
  // 只剩依赖残留，用户重试卸载必须能把它清掉。
  if (!installed.some(row => row.packageName === packageName) && deps[packageName] === undefined) {
    throw new InstallFailure('NOT_INSTALLED', `${packageName} 既没有挂载行也不在依赖里`)
  }

  emit({ type: 'step', step: 'patch' })
  await removeRow(profileDir, packageName)
  emit({ type: 'log', line: '✓ 已从 cordis.patch.yml 摘除' })

  emit({ type: 'step', step: 'download' })
  emit({ type: 'log', line: `$ pnpm remove ${packageName}` })
  const removed = await run('pnpm', ['remove', ...REMOVE_FLAGS, packageName], profileDir, emit)
  lastLog = removed.output
  if (!removed.ok) {
    // patch 行已经摘了，皮肤实际已停止生效；依赖残留不影响使用，如实说明即可。
    throw new InstallFailure(
      'PNPM_FAILED',
      `皮肤已停用，但 pnpm remove ${packageName} 失败，依赖仍留在 profile 里。`,
      tailOf(removed.output),
    )
  }
  emit({ type: 'done', packageName, needsReload: true })
}

/**
 * 授权某个包运行构建脚本：把 allowBuilds 写进 profile 的 pnpm-workspace.yaml。
 * 只在用户显式同意后调用 —— 这等于允许该包代码在本机执行。
 * @param profileDir - profile 目录。
 * @param packageName - 被授权的包。
 */
export async function allowBuilds(profileDir: string, packageName: string): Promise<void> {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  const { parseDocument, YAMLMap } = await import('yaml')
  const doc = parseDocument(text === '' ? '{}' : text)
  let allow = doc.get('allowBuilds')
  if (!(allow instanceof YAMLMap)) {
    allow = doc.createNode({}) as InstanceType<typeof YAMLMap>
    doc.set('allowBuilds', allow)
  }
  ;(allow as InstanceType<typeof YAMLMap>).set(packageName, true)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8')
}

/** 报错时只回带尾部输出：前面几十行 pnpm 进度对定位没有帮助。 */
function tailOf(output: string, lines = 12): string {
  return output.trimEnd().split('\n').slice(-lines).join('\n')
}
