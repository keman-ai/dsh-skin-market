/**
 * If a version has not shipped yet, pack a tarball and attach it to a Release.
 *
 * "Already shipped?" is decided by whether the Release tag exists, not by local git
 * tags: CI checkouts do not fetch every tag, so local state would ship duplicates.
 *
 * Single-package repo, so the tag is just v<version> — no package-name prefix as in dsh-skin-pack.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${pkg.version}`

try {
  sh('gh', ['release', 'view', tag], { stdio: ['ignore', 'pipe', 'ignore'] })
  console.log(`${tag} already shipped, skipping`)
  process.exit(0)
} catch {
  // Not shipped yet, continue
}

// npm pack does not run prepublishOnly (since npm 7 it fires only on npm publish),
// so the build must have run separately beforehand — skipping it packs an empty shell
// with no lib/
if (!existsSync('lib/index.js') || !existsSync('lib/client.js')) {
  console.error('lib/ has no build output — run pnpm build first')
  process.exit(1)
}

const file = sh('npm', ['pack', '--silent']).split('\n').pop()
sh('gh', ['release', 'create', tag, file,
  '--title', `${pkg.name} ${tag}`,
  '--notes', [
    `**${pkg.description ?? pkg.name}**`,
    '',
    'Install (recommended, tracks main):',
    '```sh',
    'dsh plugin --profile web add -w github:keman-ai/dsh-skin-market',
    '```',
    '',
    'Or pin this version:',
    '```sh',
    `dsh plugin --profile web add -w <download URL of ${file} on this page>`,
    '```',
  ].join('\n'),
])
console.log(`✓ ${tag}  ${file}`)
