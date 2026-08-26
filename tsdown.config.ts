/**
 * 两个产物：
 *   lib/index.js   host 半，普通 Node ESM，由 Loader import。
 *   lib/client.js  浏览器半，闭包工厂形态的 CJS —— 这个形状是 dsh 的模块表规定的，
 *                  不是自选：bundle 执行时调 window.__ModuleLoader__.load({id, factory})，
 *                  外部依赖由注入的 require 从宿主模块表取（没有全局、没有 import map）。
 *                  见 harness 的 packages/client/tsdown.client.ts。
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** 包名，同时是模块表里的 entry id —— 必须与 package.json 的 name 一致。 */
const ID = 'dsh-skin-market'

/**
 * 宿主共享进模块表的模块。这些保持 external，由注入的 require 解析；
 * 其余一切（含本包自己的依赖）都必须内联，因为那张表答不出来。
 * 与 harness 的 PLATFORM_MODULES 保持一致。
 */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** 虚拟 id 前缀：把 module.css 挡在 tsdown 自己的 css 流水线之外（它要求 @tsdown/css）。 */
const CSS_PREFIX = '\0skin-market-css:'
const CSS_SUFFIX = '.mjs'

/**
 * CSS Modules 内联：import 得到哈希类名表，样式文本在工厂执行时注入一个
 * <style data-plugin> 标签（宿主卸载插件时按这个属性清理）。
 */
const cssModules = {
  name: 'skin-market-css-modules',
  resolveId(source: string, importer: string | undefined): string | null {
    if (!source.endsWith('.module.css')) return null
    const absolute = importer === undefined ? source : resolve(dirname(importer), source)
    // 存相对路径：这个虚拟 id 会被 rolldown 原样写进产物的 chunk 注释里，
    // 用绝对路径就等于把构建机的目录结构（/Users/<谁>/…）发进公开仓库。
    return CSS_PREFIX + relative(process.cwd(), absolute) + CSS_SUFFIX
  },
  async load(this: { addWatchFile(id: string): void }, virtualId: string): Promise<string | null> {
    if (!virtualId.startsWith(CSS_PREFIX)) return null
    const file = resolve(process.cwd(), virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length))
    this.addWatchFile(file)
    const { code, exports } = transform({
      filename: file,
      code: await readFile(file),
      /*
       * 🔴 不用 [hash]：lightningcss 的哈希带不确定成分，同一份源码连续构建两次
       * 得到的类名都不同。后果有两个 —— lib/ 是提交进仓库的（git 源安装依赖它），
       * 每次构建都会多出几十行纯噪音的 diff；CI 里「构建产物是否与提交的一致」
       * 那道闸也就永远是红的，等于没有。
       *
       * 换成包名 + 文件名前缀：确定、可复现，作用域仍然按文件隔开，
       * 也不会跟宿主或别的插件撞。
       */
      cssModules: { pattern: 'dshmkt-[name]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    // 按 key 排序：lightningcss 返回的 exports 遍历顺序不稳定，直接写出去会让
    // 同一份源码每次构建产出不同顺序的类名表 —— 又是一堆纯噪音的 diff
    for (const [local, exported] of Object.entries(exports ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      classMap[local] = exported.name
    }
    const tagId = `${ID}/${basename(file)}`
    return [
      `const css = ${JSON.stringify(code.toString())};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
      "  const tag = document.createElement('style');",
      `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}

export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2023',
    fixedExtension: false,
    dts: false,
    clean: true,
    /*
     * 把依赖一起打进来，产物零运行时依赖。
     *
     * 分发方式决定了这一条：用户 clone 仓库后直接 `pnpm add <本地目录>`，那只是
     * 建一个符号链接，不会去装这个目录自己的 dependencies —— 于是 host 半
     * `import 'yaml'` 找不到包，dsh 启动直接失败。打进来就没有这个问题，
     * 无论走 clone、npm 还是 tarball 都一样能跑。
     */
    noExternal: (id: string) => !id.startsWith('node:'),
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2023',
    dts: false,
    // 产物要提交进仓库，sourcemap 占一半体积且对使用者无用。
    sourcemap: false,
    // host 半刚写进 lib/，这里再 clean 会把它删掉。
    clean: false,
    external: EXTERNALS,
    // tsdown 默认把 dependencies 外部化，但模块表答不出 react 之外的任何东西 ——
    // 不在 EXTERNALS 里的一律内联，否则运行时 require 直接抛。
    noExternal: (id: string) => (EXTERNALS.includes(id) ? undefined : true),
    plugins: [cssModules],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
