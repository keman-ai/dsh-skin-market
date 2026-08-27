/**
 * Spec classification and safety checks.
 *
 * This layer exists to say everything before the install button is pressed: classify what can
 * be installed and reject what cannot, right away. Making a user wait through a clone only to
 * see it fail is what every rule here avoids.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifySpec, installCommandFor } from '../src/spec.ts'

test('npm names: bare, scoped and version-ranged are all recognised', () => {
  assert.equal(classifySpec('dsh-niulai')?.kind, 'npm')
  assert.equal(classifySpec('dsh-niulai')?.bareName, 'dsh-niulai')
  assert.equal(classifySpec('@keman/dsh-niulai')?.kind, 'npm')
  assert.equal(classifySpec('@keman/dsh-niulai')?.bareName, '@keman/dsh-niulai')
  // The version must be stripped from bareName: allowBuilds matches by dependency name, and a range would never match.
  assert.equal(classifySpec('dsh-niulai@^0.1.0')?.bareName, 'dsh-niulai')
  assert.equal(classifySpec('@keman/dsh-niulai@1.2.3')?.bareName, '@keman/dsh-niulai')
  // A published artefact is not built locally, so there is no "authorise and retry" escape hatch.
  assert.equal(classifySpec('dsh-niulai')?.buildsFromSource, false)
})

test('github sources: the github: prefix and repo-root URLs are recognised and marked as building locally', () => {
  const short = classifySpec('github:keman-ai/dsh-niulai')
  assert.equal(short?.kind, 'github')
  assert.equal(short?.bareName, 'dsh-niulai')
  assert.equal(short?.buildsFromSource, true)

  assert.equal(classifySpec('github:keman-ai/dsh-niulai#v0.1.0')?.bareName, 'dsh-niulai')
  assert.equal(classifySpec('https://github.com/keman-ai/dsh-niulai.git')?.kind, 'github')
  assert.equal(classifySpec('git+https://github.com/keman-ai/dsh-niulai.git')?.kind, 'github')
})

test('🔴 a monorepo subdirectory URL is judged uninstallable rather than forced into the whole repo', () => {
  // pnpm has no notion of installing from a subdirectory of a git repo: letting it through
  // treats the whole monorepo as one package, and the user waits out a clone only to roll back
  // at mount with NOT_A_BUNDLE.
  assert.equal(classifySpec('https://github.com/keman-ai/skins/tree/main/packages/niulai'), undefined)
  assert.equal(classifySpec('github:keman-ai/skins/packages/niulai'), undefined)
})

test('tarballs: only https + an allowlisted host + .tgz pass', () => {
  const release = classifySpec(
    'https://github.com/keman-ai/skins/releases/download/niulai-v0.1.0/dsh-niulai-0.1.0.tgz',
  )
  assert.equal(release?.kind, 'tarball')
  assert.equal(release?.buildsFromSource, false)
  // No reliable dependency name can be derived from a file name, and leaving it empty closes the allowBuilds path exactly as intended.
  assert.equal(release?.bareName, undefined)

  assert.equal(classifySpec('https://registry.npmjs.org/dsh-niulai/-/dsh-niulai-0.1.0.tgz')?.kind, 'tarball')
  assert.equal(classifySpec('https://objects.githubusercontent.com/x/dsh-niulai-0.1.0.tar.gz')?.kind, 'tarball')
})

test('🔴 three red lines for tarballs: plaintext, a non-allowlisted host, a non-tarball suffix', () => {
  // A plaintext download executes locally, and a man-in-the-middle swap costs too much.
  assert.equal(classifySpec('http://github.com/o/r/releases/download/v1/x.tgz'), undefined)
  // If catalog data is rewritten, the allowlist is the second gate beyond "it was listed".
  assert.equal(classifySpec('https://evil.example.com/dsh-niulai-0.1.0.tgz'), undefined)
  // A link to a web page rather than a package: better to call it uninstallable now than fail after the click.
  assert.equal(classifySpec('https://github.com/keman-ai/dsh-niulai/releases'), undefined)
})

test('harness packages are always refused, in whichever spelling', () => {
  assert.equal(classifySpec('@deepseek-ai/dsh-client-ui-conversation'), undefined)
  assert.equal(classifySpec('dsh-base'), undefined)
  assert.equal(classifySpec('github:deepseek-ai/dsh-base'), undefined)
})

test('unrecognised input returns undefined rather than being forced into a package name', () => {
  assert.equal(classifySpec(undefined), undefined)
  assert.equal(classifySpec(''), undefined)
  assert.equal(classifySpec('   '), undefined)
  assert.equal(classifySpec('<path to clone>'), undefined)
  assert.equal(classifySpec('file:../local/skin'), undefined)
})

test('the manual install command carries -w', () => {
  // The profile directory ships a pnpm-workspace.yaml, so without -w pnpm refuses with
  // ERR_PNPM_ADDING_TO_ROOT — and this command is meant to be typed verbatim.
  assert.equal(
    installCommandFor('dsh-niulai'),
    'dsh plugin --profile web add -w dsh-niulai',
  )
  assert.equal(
    installCommandFor('dsh-niulai', 'mine'),
    'dsh plugin --profile mine add -w dsh-niulai',
  )
})
