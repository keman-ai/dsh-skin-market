/**
 * 版本号还没发过就打个 tarball 挂上 Release。
 *
 * 「发过没发过」以 Release tag 是否存在为准，不看本地 git tag：CI 的 checkout
 * 不带全部 tag，拿本地状态判断会重复发。
 *
 * 单包仓库，所以 tag 就是 v<版本>，不像 dsh-skin-pack 那样要带包名前缀。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${pkg.version}`

try {
  sh('gh', ['release', 'view', tag], { stdio: ['ignore', 'pipe', 'ignore'] })
  console.log(`${tag} 已经发过了，跳过`)
  process.exit(0)
} catch {
  // 没发过，继续
}

// npm pack 不跑 prepublishOnly（npm 7+ 起它只在 npm publish 时触发），
// 所以构建必须在这之前独立跑过 —— 漏了会打出一个没有 lib/ 的空壳
if (!existsSync('lib/index.js') || !existsSync('lib/client.js')) {
  console.error('lib/ 里缺构建产物，先跑 pnpm build')
  process.exit(1)
}

const file = sh('npm', ['pack', '--silent']).split('\n').pop()
sh('gh', ['release', 'create', tag, file,
  '--title', `${pkg.name} ${tag}`,
  '--notes', [
    `**${pkg.description ?? pkg.name}**`,
    '',
    '装它（推荐，跟着 main 走）：',
    '```sh',
    'dsh plugin --profile web add -w github:keman-ai/dsh-skin-market',
    '```',
    '',
    '或固定到这个版本：',
    '```sh',
    `dsh plugin --profile web add -w <本页 ${file} 的下载地址>`,
    '```',
  ].join('\n'),
])
console.log(`✓ ${tag}  ${file}`)
