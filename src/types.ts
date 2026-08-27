/**
 * The wire contract between the market's two halves. The client half knows only these
 * shapes, never the registry backend's raw response — when upstream fields change, only
 * catalog.ts's normalisation has to follow.
 */

import type { SpecKind } from './spec.ts'

export type { SpecKind } from './spec.ts'

/** One skin in the catalog. Variants are flattened: a repo with several skins yields one entry each. */
export interface SkinEntry {
  /** Stable id on the registry side. */
  readonly skinId: string
  /** Package identifier, for display. */
  readonly slug: string
  /** Variant name; when present it displays as `slug#variant`. */
  readonly variant?: string
  /** Display name. */
  readonly name: string
  /** One-line pitch. */
  readonly tagline?: string
  /** Author display name. */
  readonly author: string
  /** Author home page. */
  readonly authorUrl?: string
  /** Card icon. */
  readonly iconUrl?: string
  /** Category tags. */
  readonly category?: string
  /** GitHub stars, synced periodically by the registry. */
  readonly starCount: number
  /** Publication date, YYYY-MM-DD. */
  readonly releasedAt?: string
  /** Source repository. */
  readonly repoUrl?: string
  /**
   * The exact install spec (an npm package name, `github:owner/repo#sha`, or an https
   * .tgz URL). Absent means this entry is browsable but not installable — the UI disables
   * the install button rather than letting it fail after the attempt.
   */
  readonly installSpec?: string
  /**
   * The source type of this spec. It lives and dies with `installSpec`: anything
   * installable has a kind.
   *
   * The UI uses it to decide what to say and whether to offer "authorise and retry" — a
   * git source clones the whole repo and builds locally, while npm and tarball fetch a
   * finished artefact. The wait and the risk are not the same, and one blanket wording
   * would paper over that.
   */
  readonly installKind?: SpecKind
  /** The full command to type for a manual install, used by "copy command". */
  readonly installCommand?: string
  /** Successful install count, used for popularity sorting. */
  readonly installCount: number
}

/** Catalog response. */
export interface CatalogPage {
  readonly items: readonly SkinEntry[]
  readonly total: number
  readonly page: number
  readonly size: number
  /** Where the data came from: upstream, local cache or bundled snapshot. The UI says so plainly rather than pretending to be online. */
  readonly source: 'live' | 'cache' | 'snapshot'
  /** Why source is not live, shown to the user verbatim. */
  readonly staleReason?: string
}

/** One skin installed on this machine. */
export interface InstalledSkin {
  /** The package name from package.json. */
  readonly packageName: string
  /** Installed version. */
  readonly version?: string
  /** Id of the row in the profile's patch layer. */
  readonly rowId: string
  /**
   * The theme id this skin registers, read from the package's skin.json#id.
   *
   * The enable button passes it to setTheme. Package name and theme id are not the same
   * (dsh-deepseek-twin-whale registers `twinwhale`), so it must be read from the package,
   * never inferred from the name. Unreadable means no enable button, only uninstall.
   */
  readonly themeId?: string
  /** Dependency spec (an npm version or a git URL). */
  readonly spec?: string
  /** Whether the patch row is disabled. */
  readonly disabled: boolean
}

/** One event streamed back to the front end during install or uninstall. */
export type InstallEvent =
  | { readonly type: 'log'; readonly line: string }
  | { readonly type: 'step'; readonly step: InstallStep }
  | { readonly type: 'done'; readonly packageName: string; readonly needsReload: boolean }
  | { readonly type: 'error'; readonly code: InstallErrorCode; readonly message: string; readonly detail?: string }

/** Install phases, used by the UI to draw progress. */
export type InstallStep = 'resolve' | 'download' | 'patch' | 'compose'

/**
 * Failure reasons. They are fine-grained because each implies a different next step:
 * a missing pnpm needs installation guidance, a blocked build script needs user consent,
 * and a spec absent from the catalog is simply refused.
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
  | 'NOT_A_BUNDLE'

/** One row on the diagnostics page. */
export interface DiagnosticRow {
  readonly key: string
  readonly value: string
  readonly status: 'ok' | 'warn' | 'error'
  readonly hint?: string
}

/** Diagnostics snapshot. */
export interface Diagnostics {
  readonly rows: readonly DiagnosticRow[]
  /** Full output of the most recent install, for pasting to us when reporting a problem. */
  readonly lastInstallLog?: string
}
