/**
 * 安装 spec 的分类与安全校验 —— 「这条皮肤要怎么装」的单一真源。
 *
 * `pnpm add` 本身就吃三种 spec：registry 包名、`github:owner/repo`、以及远程 tarball
 * URL。三者装出来的东西一样，代价却完全不同：
 *
 * | 类型 | 下载 | 装完能直接 import 吗 | 要用户点头吗 |
 * |---|---|---|---|
 * | `npm` | registry tarball，秒级 | 能，发布物已构建 | 不用 |
 * | `tarball` | 一个 .tgz，秒级 | 能，打包时已构建 | 不用 |
 * | `github` | git clone 整个仓库，几十秒到几分钟 | **不一定** | **可能要** |
 *
 * github 源那两个「不一定」是 installer 里一半复杂度的来源：TypeScript 包要靠
 * `prepare` 构建出 lib/，而 pnpm 默认拒绝执行构建脚本，于是包装上了、入口文件却不存在。
 * 界面必须在点安装之前就把这个差别讲清楚，而不是让用户等三分钟再看见一个要授权的弹窗。
 *
 * 所以分类不是为了好看：它决定了卡片显示什么、失败时给不给「授权重试」这个出口、
 * 以及 allowBuilds 该拿哪个名字去授权。
 */

/**
 * 安装来源。
 *
 * - `npm` —— registry 上的包名，可带版本范围（`dsh-niulai`、`@scope/name@^1.0.0`）
 * - `github` —— git 源（`github:owner/repo#ref`、`git+https://…​.git`）
 * - `tarball` —— 直接指向一个 .tgz 的 https 地址（GitHub Release 附件是典型）
 */
export type SpecKind = 'npm' | 'github' | 'tarball'

/** 一条 spec 分类之后的全部事实。 */
export interface SpecInfo {
  /** 归一后的 spec，原样交给 pnpm。 */
  readonly spec: string
  readonly kind: SpecKind
  /**
   * pnpm 依赖表里这个包会叫什么 —— 仅在能可靠推断时给出。
   *
   * 只有 allowBuilds 用得上它：授权必须发生在安装之前，而真实包名要装完才知道
   * （`github:LaplaceYoung/dsh-qq2006` 装出来叫 `@dsh-external/dsh-qq2006`），
   * 所以这里给的是「pnpm 会用来匹配 allowBuilds 的那个名字」，不是包的真名。
   *
   * tarball 推不出来（文件名 `dsh-niulai-0.1.0.tgz` 既带版本号也可能与包名无关），
   * 但 tarball 本来就不需要授权，所以留 undefined 正好把这条路堵死。
   */
  readonly bareName?: string
  /**
   * 装的是源码、需要在本机构建吗。
   *
   * 为 true 时界面要提前说明「较慢，可能需要授权执行构建脚本」，
   * 失败在 BUILD_SCRIPT_BLOCKED 上时也只有它该给出「授权并重试」的出口 ——
   * 预构建的包报这个错说明包本身有问题，引导用户授权只会让他在错误的方向上花力气。
   */
  readonly buildsFromSource: boolean
}

/**
 * tarball 允许的下载主机。
 *
 * 集市目录是外部数据，一条被改写的记录可以把任意 URL 送到本机的 `pnpm add` 面前，
 * 而 tarball 里的 `postinstall` 是在用户机器上、agent 沙箱之外执行的。目录白名单
 * （`Catalog.allows`）挡的是「没收录的包」，挡不住「收录了但地址被换掉」，所以下载
 * 主机在这里再收一道。
 *
 * 名单本身是保守的：GitHub Release / codeload 与 npm registry 覆盖了正常发布路径，
 * 自建域名要进来就得改代码，这正是想要的摩擦。
 */
const TARBALL_HOSTS: readonly string[] = [
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'registry.npmjs.org',
]

/**
 * harness 自己的 scope。
 *
 * 目录里出现这种 spec 只可能是元数据填错（线上就有一条把 packageName 填成
 * `@deepseek-ai/dsh-client-ui-conversation` 的，多半是想表达「我覆盖了这个包」），
 * 照着装会把宿主自己的包塞进 profile —— 宁可标成「不可装」，
 * 也不能让一条脏数据动用户的环境。
 */
const RESERVED_SCOPE = '@deepseek-ai/'

/**
 * harness 自己的无 scope 包名。
 *
 * 这里必须精确匹配而不是前缀匹配：`dsh-base` 用 startsWith 判会连
 * `dsh-based-theme` 这种正常皮肤一起误杀。
 */
const RESERVED_NAMES: readonly string[] = ['dsh-base']

/**
 * 这个包名是 harness 自己的东西吗。
 *
 * 🔴 判定必须落在**推导出来的包名**上，不能对整条 spec 做前缀匹配 ——
 * `github:deepseek-ai/dsh-base` 剥掉协议前缀之后是 `deepseek-ai/dsh-base`，
 * 不以任何保留名开头，于是整条溜过去。
 *
 * @param name - 包名或路径段。
 * @returns 命中保留名则 true。
 */
function isReservedName(name: string): boolean {
  return name.startsWith(RESERVED_SCOPE) || RESERVED_NAMES.includes(name)
}

/** tarball 的合法扩展名。别的后缀 pnpm 也不会当 tarball 处理。 */
const TARBALL_SUFFIXES: readonly string[] = ['.tgz', '.tar.gz']

/** npm 包名（可带 scope），不含版本部分。 */
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

/**
 * `github:owner/repo` 后面还允许跟什么。
 *
 * 只认 `#ref`（分支 / tag / commit）。**不认路径**：monorepo 合并之后
 * `repoUrl` 会长成 `github.com/org/skins/tree/main/packages/niulai`，而 pnpm
 * 没有「从 git 仓库的子目录安装」这回事 —— 放它过去的结果是把整个 monorepo
 * 当一个包装进 profile，然后在挂载那步以 NOT_A_BUNDLE 回滚。
 * 与其让用户等完一次 clone 再看见失败，不如在这里就判定为不可装。
 */
const GITHUB_TARGET = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([\w./-]+))?$/

/** 去掉 npm spec 尾部的版本部分，留下包名。 */
function npmNameOf(spec: string): string | undefined {
  // scope 包的 `@` 在开头，版本分隔符是**后面**那个 `@`，所以从第 1 位开始找。
  const at = spec.indexOf('@', 1)
  const name = at < 0 ? spec : spec.slice(0, at)
  return NPM_NAME.test(name) ? name : undefined
}

/** 这个 URL 指向一个 tarball 吗。 */
function isTarballUrl(url: URL): boolean {
  const path = url.pathname.toLowerCase()
  return TARBALL_SUFFIXES.some(suffix => path.endsWith(suffix))
}

/**
 * 把一条 spec 归类，顺带把不该装的挡在外面。
 *
 * 认不出、或者认出来但不安全（http 明文、主机不在白名单、指向 monorepo 子目录、
 * 是 harness 自己的包），一律返回 undefined —— 调用方据此把条目标成「不可装」，
 * 这比装到一半失败要诚实得多。
 *
 * @param spec - 集市给的安装 spec。
 * @returns 分类结果；判定为不可装时 undefined。
 */
export function classifySpec(spec: string | undefined): SpecInfo | undefined {
  if (spec === undefined) return undefined
  const trimmed = spec.trim()
  if (trimmed === '') return undefined

  if (trimmed.startsWith('github:')) {
    return githubInfo(trimmed, trimmed.slice('github:'.length))
  }

  if (/^(?:git\+)?https?:\/\//.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed.replace(/^git\+/, ''))
    } catch {
      return undefined
    }
    // 明文下载的包会在本机执行；中间人换掉 tarball 的代价太大，不留这个口子。
    if (url.protocol !== 'https:') return undefined

    if (isTarballUrl(url)) {
      if (!TARBALL_HOSTS.includes(url.hostname)) return undefined
      // registry 的 tarball 地址里带着包名（`/@deepseek-ai/dsh-base/-/…​.tgz`），
      // 逐段查一遍就能把绕道 tarball 装 harness 自己包的路也堵上。
      if (url.pathname.split('/').some(isReservedName)) return undefined
      return { spec: trimmed, kind: 'tarball', buildsFromSource: false }
    }

    // 剩下的 https 只有 GitHub 仓库地址才当 git 源，其余（比如指向网页的链接）不可装。
    if (url.hostname !== 'github.com') return undefined
    return githubInfo(trimmed, `${url.pathname.replace(/^\//, '')}${url.hash}`)
  }

  const name = npmNameOf(trimmed)
  if (name === undefined || isReservedName(name)) return undefined
  return { spec: trimmed, kind: 'npm', bareName: name, buildsFromSource: false }
}

/**
 * 校验 `owner/repo[#ref]` 部分并组装 github 分类。
 * @param spec - 原样回传给 pnpm 的 spec。
 * @param target - 去掉协议前缀之后的 `owner/repo[#ref]`。
 * @returns 分类结果；带子路径等不可装形态时 undefined。
 */
function githubInfo(spec: string, target: string): SpecInfo | undefined {
  const match = GITHUB_TARGET.exec(target)
  if (match === null) return undefined
  const repo = match[2]
  if (repo === undefined || isReservedName(repo)) return undefined
  return { spec, kind: 'github', bareName: repo, buildsFromSource: true }
}

/**
 * 用户想手动装时该敲的那条命令。
 *
 * `-w` 不能省：profile 目录自带 `pnpm-workspace.yaml`，pnpm 因此认定它是 workspace 根
 * 并以 ERR_PNPM_ADDING_TO_ROOT 拒绝安装。
 *
 * @param spec - 安装 spec。
 * @param profile - profile 名，默认 web。
 * @returns 完整命令。
 */
export function installCommandFor(spec: string, profile = 'web'): string {
  return `dsh plugin --profile ${profile} add -w ${spec}`
}
