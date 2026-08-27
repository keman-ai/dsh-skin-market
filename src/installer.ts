/**
 * Install execution: probe pnpm → `pnpm add` → write the user patch layer → hot recompose.
 *
 * Transactional: pnpm first, patch row only on success, and the package is uninstalled if the row fails. A half-installed state is harder to diagnose than a failed install.
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
 * Ceiling for a single pnpm invocation.
 *
 * 🔴 It was 5 minutes, which measurement showed is not enough: a 68.7 MB skin repository
 * (the author embedded assets into the bundle, not unusual for skins) cloned through a proxy
 * was killed at 310 seconds while barely half done, discarding 132 MB already downloaded and
 * forcing a retry from scratch. Mistaking "slow" for "hung" costs far more than waiting.
 *
 * Twenty minutes is a worst-case backstop, not an expectation — a normal repository finishes
 * in tens of seconds. A genuine hang still terminates rather than spinning forever.
 */
const PNPM_TIMEOUT_MS = 20 * 60 * 1000

/**
 * Heartbeat interval: during a git clone pnpm is completely silent (its progress bar is a TTY
 * animation, and under append-only the `Progress: resolved N` line does not move until the
 * clone finishes), so the UI looks dead. A line every so often says "still alive", telling
 * people to wait rather than retry — a second install click starts a second pnpm competing for
 * the same bandwidth, which only makes it slower. We have hit exactly that.
 */
const HEARTBEAT_MS = 20 * 1000

/**
 * The profile directory ships a `pnpm-workspace.yaml` (`packages: ['.']`, written by dsh at
 * init), so pnpm reads it as a workspace root and `pnpm add` refuses with
 * ERR_PNPM_ADDING_TO_ROOT. This flag is the "yes, install into the root" declaration —
 * measured: without it, nothing installs.
 */
const ROOT_FLAG = '--ignore-workspace-root-check'

/**
 * The default reporter prints almost nothing outside a TTY (progress is a TTY animation), so
 * during the tens of seconds a git source takes, the UI shows a single DeprecationWarning and
 * looks hung. append-only prints progress line by line.
 */
const REPORTER_FLAG = '--reporter=append-only'

/**
 * Arguments for `pnpm add`. Only add understands ROOT_FLAG — passing it to remove fails
 * outright with "Unknown option", breaking uninstall.
 */
const ADD_FLAGS = [ROOT_FLAG, REPORTER_FLAG]

/** Arguments for `pnpm remove`. */
const REMOVE_FLAGS = [REPORTER_FLAG]

/** The most recent output, returned in diagnostics and error messages. */
let lastLog = ''

/** Full output of the most recent install or uninstall. */
export const getLastLog = (): string => lastLog

/** The result of one pnpm invocation. */
interface RunResult {
  readonly ok: boolean
  readonly output: string
}

/** Event callback. */
export type Emit = (event: InstallEvent) => void

/** A failure carrying a code, from which the route layer decides the status and the message. */
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
 * Run a command, streaming its output line by line.
 * @param command - The executable.
 * @param args - Arguments.
 * @param cwd - Working directory.
 * @param emit - Line callback; omit it to collect without streaming.
 * @returns The exit code and the full output.
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
      output += `\n[timeout] the command did not finish within ${PNPM_TIMEOUT_MS / 60_000} minutes and was terminated.`
        + '\nA very large repository or a very slow network ends up here; what was downloaded is not kept, and a retry starts over.'
    }, PNPM_TIMEOUT_MS)

    // Heartbeat during silence. Emitted only when there really is no new output; when there is, let the output speak.
    let quietSince = Date.now()
    const heartbeat = setInterval(() => {
      if (settled || emit === undefined) return
      if (Date.now() - quietSince < HEARTBEAT_MS) return
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      emit({ type: 'log', line: `… still downloading, ${seconds}s elapsed (a large repository can take minutes — please do not click again)` })
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

/** One direct dependency of the profile, as pnpm sees it. */
interface InstalledPackage {
  readonly name: string
  readonly path: string
}

/**
 * Ask pnpm for the top-level dependency list and their **real paths**.
 *
 * This is the authoritative source for package names and directories: joining
 * `node_modules/<name>` after an install can miss (under the isolated layout the top level is
 * only a symlink, with no guarantee of when it appears), whereas pnpm tells us directly that
 * the real files are in `.pnpm/<hash>/node_modules/<name>`.
 * @param profileDir - The profile directory.
 * @returns A name-to-path map; empty when pnpm cannot answer, and callers fall back themselves.
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
    // pnpm printed something before its JSON — treat this round as unanswerable.
  }
  return out
}

/**
 * Is pnpm present, and at what version.
 * @param cwd - Working directory.
 * @returns The version, or undefined when pnpm is not installed.
 */
export async function pnpmVersion(cwd: string): Promise<string | undefined> {
  const result = await run('pnpm', ['--version'], cwd)
  return result.ok ? result.output.trim().split('\n').pop() : undefined
}

/**
 * Does the installed package's declared entry file actually exist?
 *
 * This is the most important gate: a TypeScript package from a git source relies on `prepare`
 * to produce lib/, but pnpm refuses build scripts by default, so the package installs while
 * `lib/index.js` does not exist. Once such a package is written into the config, the Loader
 * crashes at the next start with ERR_MODULE_NOT_FOUND — **the whole of dsh fails to boot**,
 * far worse than a skin that does nothing. So verify before mounting, and roll back on a
 * missing file.
 * @param packageDir - The package's actual directory.
 * @returns The list of missing entry files; an empty array means loadable.
 */
async function missingEntries(packageDir: string): Promise<string[]> {
  let manifest: { main?: unknown; exports?: unknown }
  try {
    manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    return ['package.json']
  }

  // exports may be a string, a conditions object or a nested object — flatten them all into candidate relative paths.
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
    // A wildcard export (./src/*) denotes a family of files; verifying them one by one is meaningless.
    if (relative.includes('*')) continue
    try {
      await access(join(packageDir, relative), fsConstants.F_OK)
    } catch {
      missing.push(relative)
    }
  }
  return missing
}

/** pnpm skipped prepare because build scripts were not authorised — a git source then lacks build output and cannot load. */
const blockedBuild = (output: string): boolean => (
  /ignored build scripts|approve-builds|allowBuilds/i.test(output)
)

/**
 * Install a skin package.
 * @param profileDir - The profile directory (= ctx.baseUrl).
 * @param spec - The install spec, already validated against the catalog allowlist.
 * @param packageName - The expected package name, used to write the patch row.
 * @param emit - Progress events.
 * @throws InstallFailure when any stage fails.
 */
export async function install(
  profileDir: string, spec: string, emit: Emit,
): Promise<string> {
  if (!await isWritable(profileDir)) {
    throw new InstallFailure('PROFILE_UNRESOLVED', `profile directory is not writable: ${profileDir}`)
  }
  // Deduplicate by spec, not by package name — the name is known only after installing (see
  // below). This blocks only "installed and mounted"; "dependency present but not mounted" is a
  // repairable inconsistency left by a half-failed uninstall, so it proceeds normally.
  const installed = await listInstalled(profileDir)
  if (installed.some(row => row.spec === spec)) {
    throw new InstallFailure('ALREADY_INSTALLED', `${spec} is already installed`)
  }
  if (await pnpmVersion(profileDir) === undefined) {
    throw new InstallFailure(
      'PNPM_MISSING',
      'pnpm is not on PATH. dsh plugin installation forwards to pnpm, so it must be installed first.',
      'Try corepack enable pnpm, or npm i -g pnpm',
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
    throw new InstallFailure('PNPM_FAILED', `pnpm add ${spec} failed`, tailOf(added.output))
  }

  /*
   * The real package name can only be read from the install result, never guessed from the
   * spec: `github:LaplaceYoung/dsh-qq2006` installs as `@dsh-external/dsh-qq2006`. Guessing
   * wrong writes an unresolvable module name into the patch — pnpm reports success while the
   * skin silently does nothing.
   */
  const packages = await inventory(profileDir)
  const after = await readDependencies(profileDir)
  // When the dependency is already present pnpm just says Already up to date and adds nothing —
  // so look the existing dependency up by spec, rather than pinning a "cannot install" verdict
  // on a package that is in fact installed.
  const packageName = [...packages.keys()].find(name => !before.has(name))
    ?? Object.keys(after).find(name => !before.has(name))
    ?? await findBySpec(profileDir, spec)
  if (packageName === undefined) {
    throw new InstallFailure(
      'PNPM_FAILED',
      'pnpm reported success, but this spec is absent from the profile dependencies, so the installed package name cannot be determined',
      tailOf(added.output),
    )
  }
  emit({ type: 'log', line: `✓ installed ${packageName}` })

  // pnpm still exits 0 when build scripts are skipped, but a git-source package then lacks its
  // build output and cannot load — so treat it as a failure and roll back, rather than letting
  // the user refresh into a broken dsh.
  if (blockedBuild(added.output)) {
    await run('pnpm', ['remove', ...REMOVE_FLAGS, packageName], profileDir)
    throw buildBlocked(packageName)
  }

  // Confirm the package can actually be imported before mounting: writing one without build output into the config stops dsh from booting.
  const packageDir = packages.get(packageName)?.path
  if (packageDir !== undefined) {
    const missing = await missingEntries(packageDir)
    if (missing.length > 0) {
      await run('pnpm', ['remove', ...REMOVE_FLAGS, packageName], profileDir)
      throw new InstallFailure(
        'BUILD_SCRIPT_BLOCKED',
        `${packageName} is missing the entry file it declares; installing it would break dsh's next start, so it has been uninstalled.`,
        `Missing: ${missing.join(', ')}. Packages like this build at install time (a prepare script), `
        + 'which pnpm does not run by default. You may authorise and retry — that permits this '
        + "package's code to execute on your machine, outside the agent sandbox.",
      )
    }
  }

  emit({ type: 'step', step: 'patch' })
  try {
    const applied = await applyBundlePatch(profileDir, packageName, packageDir)
    emit({ type: 'log', line: `✓ inlined the ${applied.rows} patch row(s) declared by ${packageName} into the profile` })
    if (applied.repaired > 0) {
      // Say it plainly: we altered what the author wrote, and the user has a right to know.
      emit({
        type: 'log',
        line: `⚠ ${applied.repaired} of them were written as "edit a row that does not exist" and were repaired to "mount myself" — `
          + 'otherwise this skin would install and do nothing (the same happens via the official command; consider telling the author)',
      })
    }
  } catch (error) {
    // If mounting fails, uninstall the package: better that nothing happened than a half state where it is installed but not mounted.
    await run('pnpm', ['remove', ...REMOVE_FLAGS, packageName], profileDir)
    const reason = error instanceof Error ? error.message : String(error)
    // "What we downloaded is not a skin bundle at all" is a catalog-data problem, not a config
    // write failure. Separate codes tell the user to contact the author instead of checking
    // their own disk permissions.
    const notABundle = reason.includes('no package.json') || reason.includes('declares no dsh.bundle')
    throw new InstallFailure(
      notABundle ? 'NOT_A_BUNDLE' : 'PATCH_WRITE_FAILED',
      notABundle ? `${spec} cannot be installed; the downloaded package has been removed.` : `${packageName} failed to mount; the package has been removed.`,
      reason,
    )
  }

  emit({ type: 'step', step: 'compose' })
  emit({ type: 'log', line: '✓ the Loader tree will recompose within about a second (no process restart)' })
  emit({ type: 'done', packageName, needsReload: true })
  return packageName
}

/** The single wording for pnpm blocking build scripts: this needs explicit user consent and must never be decided for them. */
function buildBlocked(target: string): InstallFailure {
  return new InstallFailure(
    'BUILD_SCRIPT_BLOCKED',
    `${target} needs to run build scripts at install time, which pnpm refused by default.`,
    "Agreeing permits this package's code to execute on your machine, outside the agent sandbox. "
    + 'On confirmation we write allowBuilds into the profile pnpm-workspace.yaml and retry.',
  )
}

/**
 * Uninstall a skin package: remove the patch row first (stopping the mount), then the dependency.
 * @param profileDir - The profile directory.
 * @param packageName - The package name.
 * @param emit - Progress events.
 * @throws InstallFailure when it was never installed, or pnpm fails.
 */
export async function uninstall(profileDir: string, packageName: string, emit: Emit): Promise<void> {
  const installed = await listInstalled(profileDir)
  const deps = await readDependencies(profileDir)
  // Either "the mount row is still there" or "the dependency is still there" qualifies: if a
  // previous uninstall failed at the pnpm step, only the dependency remains, and a retry must
  // be able to clear it.
  if (!installed.some(row => row.packageName === packageName) && deps[packageName] === undefined) {
    throw new InstallFailure('NOT_INSTALLED', `${packageName} has neither a mount row nor a dependency entry`)
  }

  emit({ type: 'step', step: 'patch' })
  await removeRow(profileDir, packageName)
  emit({ type: 'log', line: '✓ removed from cordis.patch.yml' })

  emit({ type: 'step', step: 'download' })
  emit({ type: 'log', line: `$ pnpm remove ${packageName}` })
  const removed = await run('pnpm', ['remove', ...REMOVE_FLAGS, packageName], profileDir, emit)
  lastLog = removed.output
  if (!removed.ok) {
    // The patch row is gone, so the skin has already stopped taking effect; a leftover dependency is harmless — just say so.
    throw new InstallFailure(
      'PNPM_FAILED',
      `The skin is disabled, but pnpm remove ${packageName} failed and the dependency remains in the profile.`,
      tailOf(removed.output),
    )
  }
  emit({ type: 'done', packageName, needsReload: true })
}

/**
 * Authorise a package to run build scripts by writing allowBuilds into the profile's
 * pnpm-workspace.yaml. Called only after explicit user consent — it permits that package's
 * code to execute locally.
 * @param profileDir - The profile directory.
 * @param packageName - The package being authorised.
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

/** On error, return only the tail: the preceding dozens of pnpm progress lines do not help diagnosis. */
function tailOf(output: string, lines = 12): string {
  return output.trimEnd().split('\n').slice(-lines).join('\n')
}
