/**
 * Classification and safety checks for install specs — the single source of truth for "how does this skin install".
 *
 * `pnpm add` accepts three spec kinds: a registry name, `github:owner/repo`, and a remote
 * tarball URL. They install the same thing at very different costs:
 *
 * | Kind | Download | Importable right away? | Needs user consent? |
 * |---|---|---|---|
 * | `npm` | registry tarball, seconds | Yes, the published artefact is built | No |
 * | `tarball` | one .tgz, seconds | Yes, built at pack time | No |
 * | `github` | git clone of the whole repo, tens of seconds to minutes | **Not always** | **Possibly** |
 *
 * Those two "not always" cells account for half the complexity in the installer: a
 * TypeScript package relies on `prepare` to produce lib/, but pnpm refuses build scripts
 * by default, so the package installs while its entry file does not exist. The UI must
 * make that difference clear before the install button is pressed, not after a three-minute
 * wait ending in a consent dialog.
 *
 * So classification is not cosmetic: it decides what the card says, whether a failure
 * offers "authorise and retry", and which name allowBuilds must be given.
 */

/**
 * Install source.
 *
 * - `npm` — a registry name, optionally with a version range (`dsh-niulai`, `@scope/name@^1.0.0`)
 * - `github` — a git source (`github:owner/repo#ref`, `git+https://….git`)
 * - `tarball` — an https URL pointing straight at a .tgz (a GitHub Release asset, typically)
 */
export type SpecKind = 'npm' | 'github' | 'tarball'

/** Everything known about a spec once classified. */
export interface SpecInfo {
  /** The normalised spec, handed to pnpm verbatim. */
  readonly spec: string
  readonly kind: SpecKind
  /**
   * What pnpm's dependency table will call this package — given only when it can be
   * inferred reliably.
   *
   * Only allowBuilds needs it: consent must happen before installation, yet the real
   * package name is known only afterwards (`github:LaplaceYoung/dsh-qq2006` installs as
   * `@dsh-external/dsh-qq2006`). So this is the name pnpm will match allowBuilds against,
   * not the package's true name.
   *
   * It cannot be inferred for tarballs (a file named `dsh-niulai-0.1.0.tgz` carries a
   * version and may not match the package name at all) — but tarballs never need consent,
   * so leaving it undefined closes that path exactly as intended.
   */
  readonly bareName?: string
  /**
   * Does this install source that must be built locally?
   *
   * When true the UI must warn up front that this is slower and may require authorising
   * build scripts, and only then may a BUILD_SCRIPT_BLOCKED failure offer "authorise and
   * retry" — a prebuilt package reporting that error has a problem of its own, and
   * nudging the user to grant consent just sends them down the wrong path.
   */
  readonly buildsFromSource: boolean
}

/**
 * Hosts a tarball may be downloaded from.
 *
 * The registry catalog is external data, and one rewritten record could hand an arbitrary
 * URL to the local `pnpm add`, while a tarball's `postinstall` runs on the user's machine
 * outside the agent sandbox. The catalog allowlist (`Catalog.allows`) blocks packages that
 * are not listed; it cannot block a listed package whose URL was swapped. Hence a second
 * gate on the download host.
 *
 * The list is deliberately conservative: GitHub Releases / codeload and the npm registry
 * cover every normal publishing route, and adding a custom domain requires a code change —
 * exactly the friction we want.
 */
const TARBALL_HOSTS: readonly string[] = [
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'registry.npmjs.org',
]

/**
 * The harness's own scope.
 *
 * A spec like this in the catalog can only be bad metadata (production has one entry whose
 * packageName is `@deepseek-ai/dsh-client-ui-conversation`, probably meaning "I override
 * this package"), and installing it would push a host package into the profile. Better to
 * mark it uninstallable than let one dirty record touch a user's environment.
 */
const RESERVED_SCOPE = '@deepseek-ai/'

/**
 * The harness's own unscoped package names.
 *
 * These must match exactly, not by prefix: testing `dsh-base` with startsWith would also
 * kill a perfectly normal skin named `dsh-based-theme`.
 */
const RESERVED_NAMES: readonly string[] = ['dsh-base']

/**
 * Is this package name one of the harness's own?
 *
 * 🔴 The test must run on the **derived package name**, never as a prefix match on the whole
 * spec — `github:deepseek-ai/dsh-base` becomes `deepseek-ai/dsh-base` once the protocol is
 * stripped, starts with no reserved name, and would slip straight through.
 *
 * @param name - A package name or path segment.
 * @returns True when it hits a reserved name.
 */
function isReservedName(name: string): boolean {
  return name.startsWith(RESERVED_SCOPE) || RESERVED_NAMES.includes(name)
}

/** Valid tarball extensions. pnpm would not treat any other suffix as a tarball either. */
const TARBALL_SUFFIXES: readonly string[] = ['.tgz', '.tar.gz']

/** An npm package name, optionally scoped, without the version part. */
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

/**
 * What may follow `github:owner/repo`.
 *
 * Only `#ref` (branch / tag / commit). **No paths**: after the monorepo merge a `repoUrl`
 * grows into `github.com/org/skins/tree/main/packages/niulai`, and pnpm has no notion of
 * installing from a subdirectory of a git repo — letting it through installs the whole
 * monorepo as one package into the profile, then rolls back at the mount step with
 * NOT_A_BUNDLE. Better to call it uninstallable here than after a full clone.
 */
const GITHUB_TARGET = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([\w./-]+))?$/

/** Strip the trailing version from an npm spec, leaving the package name. */
function npmNameOf(spec: string): string | undefined {
  // A scoped package's `@` is at position 0; the version separator is the *later* `@`, so search from index 1.
  const at = spec.indexOf('@', 1)
  const name = at < 0 ? spec : spec.slice(0, at)
  return NPM_NAME.test(name) ? name : undefined
}

/** Does this URL point at a tarball? */
function isTarballUrl(url: URL): boolean {
  const path = url.pathname.toLowerCase()
  return TARBALL_SUFFIXES.some(suffix => path.endsWith(suffix))
}

/**
 * Classify a spec, and block what should not be installed along the way.
 *
 * Unrecognised, or recognised but unsafe (plaintext http, a host outside the allowlist, a
 * monorepo subdirectory, a harness package) all return undefined — the caller marks the
 * entry uninstallable, which is far more honest than failing halfway through.
 *
 * @param spec - The install spec from the registry.
 * @returns The classification, or undefined when judged uninstallable.
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
    // A plaintext download executes locally; a man-in-the-middle swapping the tarball costs too much to allow.
    if (url.protocol !== 'https:') return undefined

    if (isTarballUrl(url)) {
      if (!TARBALL_HOSTS.includes(url.hostname)) return undefined
      // A registry tarball URL carries the package name (`/@deepseek-ai/dsh-base/-/….tgz`),
      // so checking each segment also closes the tarball route to a harness package.
      if (url.pathname.split('/').some(isReservedName)) return undefined
      return { spec: trimmed, kind: 'tarball', buildsFromSource: false }
    }

    // Of the remaining https URLs only GitHub repo URLs count as git sources; the rest (a link to a web page, say) are uninstallable.
    if (url.hostname !== 'github.com') return undefined
    return githubInfo(trimmed, `${url.pathname.replace(/^\//, '')}${url.hash}`)
  }

  const name = npmNameOf(trimmed)
  if (name === undefined || isReservedName(name)) return undefined
  return { spec: trimmed, kind: 'npm', bareName: name, buildsFromSource: false }
}

/**
 * Validate the `owner/repo[#ref]` part and build the github classification.
 * @param spec - The spec passed back to pnpm verbatim.
 * @param target - The `owner/repo[#ref]` left after stripping the protocol.
 * @returns The classification, or undefined for uninstallable shapes such as a subpath.
 */
function githubInfo(spec: string, target: string): SpecInfo | undefined {
  const match = GITHUB_TARGET.exec(target)
  if (match === null) return undefined
  const repo = match[2]
  if (repo === undefined || isReservedName(repo)) return undefined
  return { spec, kind: 'github', bareName: repo, buildsFromSource: true }
}

/**
 * The command a user types to install manually.
 *
 * `-w` is not optional: the profile directory ships a `pnpm-workspace.yaml`, so pnpm reads
 * it as a workspace root and refuses with ERR_PNPM_ADDING_TO_ROOT.
 *
 * @param spec - The install spec.
 * @param profile - Profile name, defaulting to web.
 * @returns The full command.
 */
export function installCommandFor(spec: string, profile = 'web'): string {
  return `dsh plugin --profile ${profile} add -w ${spec}`
}
