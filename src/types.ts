/**
 * 市场两半之间的线上契约。client 半只认这里的形状，不认集市后端的原始响应 ——
 * 上游字段有变化时，只有 catalog.ts 的归一化需要改。
 */

/** 目录里的一条皮肤。变体已展平：一个仓库带多套皮肤时，每套是独立一条。 */
export interface SkinEntry {
  /** 集市侧的稳定 id。 */
  readonly skinId: string
  /** 包标识，展示用。 */
  readonly slug: string
  /** 变体名；有值时展示为 `slug#variant`。 */
  readonly variant?: string
  /** 展示名。 */
  readonly name: string
  /** 一句话卖点。 */
  readonly tagline?: string
  /** 作者展示名。 */
  readonly author: string
  /** 作者主页。 */
  readonly authorUrl?: string
  /** 卡片图标。 */
  readonly iconUrl?: string
  /** 分类标签。 */
  readonly category?: string
  /** GitHub star，集市侧定时同步而来。 */
  readonly starCount: number
  /** 发布日期 YYYY-MM-DD。 */
  readonly releasedAt?: string
  /** 源码仓库。 */
  readonly repoUrl?: string
  /**
   * 安装用的确切 spec（npm 包名，或 `github:owner/repo#sha`）。
   * 缺失表示这条只能看不能装 —— UI 据此禁用安装按钮，而不是装了才失败。
   */
  readonly installSpec?: string
  /** 安装成功次数，热度排序用。 */
  readonly installCount: number
}

/** 目录响应。 */
export interface CatalogPage {
  readonly items: readonly SkinEntry[]
  readonly total: number
  readonly page: number
  readonly size: number
  /** 数据从哪来：上游、本地缓存、还是随包快照。UI 直说，不假装在线。 */
  readonly source: 'live' | 'cache' | 'snapshot'
  /** source 非 live 时的原因，原样展示给用户。 */
  readonly staleReason?: string
}

/** 本机已装的一条皮肤。 */
export interface InstalledSkin {
  /** package.json 里的包名。 */
  readonly packageName: string
  /** 已装版本。 */
  readonly version?: string
  /** profile 的 patch 层里那一行的 id。 */
  readonly rowId: string
  /** 依赖 spec（npm 版本号或 git 地址）。 */
  readonly spec?: string
  /** patch 行是否被停用。 */
  readonly disabled: boolean
}

/** 安装/卸载过程中回流给前端的一条事件。 */
export type InstallEvent =
  | { readonly type: 'log'; readonly line: string }
  | { readonly type: 'step'; readonly step: InstallStep }
  | { readonly type: 'done'; readonly packageName: string; readonly needsReload: boolean }
  | { readonly type: 'error'; readonly code: InstallErrorCode; readonly message: string; readonly detail?: string }

/** 安装的几个阶段，UI 用来画进度。 */
export type InstallStep = 'resolve' | 'download' | 'patch' | 'compose'

/**
 * 失败原因。分得细是因为每种的下一步动作不同：缺 pnpm 要引导安装，
 * 构建脚本被拦要用户授权，spec 不在目录里要直接拒绝。
 */
export type InstallErrorCode =
  | 'PNPM_MISSING'
  | 'BUILD_SCRIPT_BLOCKED'
  | 'SPEC_NOT_IN_CATALOG'
  | 'NOT_LOOPBACK'
  | 'PROFILE_UNRESOLVED'
  | 'PNPM_FAILED'
  | 'PATCH_WRITE_FAILED'
  | 'ALREADY_INSTALLED'
  | 'NOT_INSTALLED'

/** 诊断页的一行。 */
export interface DiagnosticRow {
  readonly key: string
  readonly value: string
  readonly status: 'ok' | 'warn' | 'error'
  readonly hint?: string
}

/** 诊断快照。 */
export interface Diagnostics {
  readonly rows: readonly DiagnosticRow[]
  /** 最近一次安装的完整输出，贴给我们排查用。 */
  readonly lastInstallLog?: string
}
