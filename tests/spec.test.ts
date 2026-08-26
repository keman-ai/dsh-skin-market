/**
 * spec 分类与安全校验。
 *
 * 这一层的职责是「在点安装之前就把话说清楚」：能装的分好类，不能装的当场判死 ——
 * 让用户等完一次 clone 再看见失败，是这里每一条规则要避免的事。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifySpec, installCommandFor } from '../src/spec.ts'

test('npm 包名：裸名、scope、带版本范围都认', () => {
  assert.equal(classifySpec('dsh-niulai')?.kind, 'npm')
  assert.equal(classifySpec('dsh-niulai')?.bareName, 'dsh-niulai')
  assert.equal(classifySpec('@keman/dsh-niulai')?.kind, 'npm')
  assert.equal(classifySpec('@keman/dsh-niulai')?.bareName, '@keman/dsh-niulai')
  // 版本部分要从 bareName 里剥掉：allowBuilds 按依赖名匹配，带上范围就匹配不到。
  assert.equal(classifySpec('dsh-niulai@^0.1.0')?.bareName, 'dsh-niulai')
  assert.equal(classifySpec('@keman/dsh-niulai@1.2.3')?.bareName, '@keman/dsh-niulai')
  // 发布物不在本机构建，所以不该给「授权重试」的出口。
  assert.equal(classifySpec('dsh-niulai')?.buildsFromSource, false)
})

test('github 源：认 github: 前缀与仓库根 URL，并标记为要在本机构建', () => {
  const short = classifySpec('github:keman-ai/dsh-niulai')
  assert.equal(short?.kind, 'github')
  assert.equal(short?.bareName, 'dsh-niulai')
  assert.equal(short?.buildsFromSource, true)

  assert.equal(classifySpec('github:keman-ai/dsh-niulai#v0.1.0')?.bareName, 'dsh-niulai')
  assert.equal(classifySpec('https://github.com/keman-ai/dsh-niulai.git')?.kind, 'github')
  assert.equal(classifySpec('git+https://github.com/keman-ai/dsh-niulai.git')?.kind, 'github')
})

test('🔴 monorepo 子目录地址判定为不可装，而不是硬推成整个仓库', () => {
  // pnpm 没有「从 git 仓库子目录安装」这回事：放过去等于把整个 monorepo 当一个包，
  // 用户等完 clone 才在挂载那步以 NOT_A_BUNDLE 回滚。
  assert.equal(classifySpec('https://github.com/keman-ai/skins/tree/main/packages/niulai'), undefined)
  assert.equal(classifySpec('github:keman-ai/skins/packages/niulai'), undefined)
})

test('tarball：https + 白名单主机 + .tgz 才放行', () => {
  const release = classifySpec(
    'https://github.com/keman-ai/skins/releases/download/niulai-v0.1.0/dsh-niulai-0.1.0.tgz',
  )
  assert.equal(release?.kind, 'tarball')
  assert.equal(release?.buildsFromSource, false)
  // 文件名推不出可靠的依赖名，留空正好把 allowBuilds 这条路堵死。
  assert.equal(release?.bareName, undefined)

  assert.equal(classifySpec('https://registry.npmjs.org/dsh-niulai/-/dsh-niulai-0.1.0.tgz')?.kind, 'tarball')
  assert.equal(classifySpec('https://objects.githubusercontent.com/x/dsh-niulai-0.1.0.tar.gz')?.kind, 'tarball')
})

test('🔴 tarball 的三条红线：明文、非白名单主机、非 tarball 后缀', () => {
  // 明文下载的包会在本机执行，中间人换掉它的代价太大。
  assert.equal(classifySpec('http://github.com/o/r/releases/download/v1/x.tgz'), undefined)
  // 目录数据被改写时，白名单是「收录过」之外的第二道闸。
  assert.equal(classifySpec('https://evil.example.com/dsh-niulai-0.1.0.tgz'), undefined)
  // 指向网页而不是包的链接，点了才失败不如现在就说不可装。
  assert.equal(classifySpec('https://github.com/keman-ai/dsh-niulai/releases'), undefined)
})

test('harness 自己的包一律不放行，换成哪种写法都一样', () => {
  assert.equal(classifySpec('@deepseek-ai/dsh-client-ui-conversation'), undefined)
  assert.equal(classifySpec('dsh-base'), undefined)
  assert.equal(classifySpec('github:deepseek-ai/dsh-base'), undefined)
})

test('认不出来的输入返回 undefined，而不是硬当成包名', () => {
  assert.equal(classifySpec(undefined), undefined)
  assert.equal(classifySpec(''), undefined)
  assert.equal(classifySpec('   '), undefined)
  assert.equal(classifySpec('<克隆路径>'), undefined)
  assert.equal(classifySpec('file:../local/skin'), undefined)
})

test('手动安装命令带着 -w', () => {
  // profile 目录自带 pnpm-workspace.yaml，少了 -w 会被 pnpm 以
  // ERR_PNPM_ADDING_TO_ROOT 拒绝 —— 这条命令是给用户照着敲的，不能少。
  assert.equal(
    installCommandFor('dsh-niulai'),
    'dsh plugin --profile web add -w dsh-niulai',
  )
  assert.equal(
    installCommandFor('dsh-niulai', 'mine'),
    'dsh plugin --profile mine add -w dsh-niulai',
  )
})
