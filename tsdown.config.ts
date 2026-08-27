/**
 * Two outputs:
 *   lib/index.js   host half, plain Node ESM, imported by the Loader.
 *   lib/client.js  browser half, CJS in closure-factory form — a shape dictated by dsh's
 *                  module table, not chosen: on execution the bundle calls
 *                  window.__ModuleLoader__.load({id, factory}), and external deps come
 *                  from the host module table via an injected require (no globals, no
 *                  import map). See the harness packages/client/tsdown.client.ts.
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Package name, and the entry id in the module table — must match package.json's name. */
const ID = 'dsh-skin-market'

/**
 * Modules the host shares through the module table. These stay external and are resolved
 * by the injected require; everything else — including this package's own dependencies —
 * must be inlined, because the table cannot answer for them.
 * Kept in sync with the harness PLATFORM_MODULES.
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

/** Virtual id prefix, keeping module.css out of tsdown's own CSS pipeline (which needs @tsdown/css). */
const CSS_PREFIX = '\0skin-market-css:'
const CSS_SUFFIX = '.mjs'

/**
 * Inline CSS Modules: the import yields a hashed class-name map, and the style text is
 * injected as a <style data-plugin> tag when the factory runs (the host cleans up by
 * that attribute when unloading the plugin).
 */
const cssModules = {
  name: 'skin-market-css-modules',
  resolveId(source: string, importer: string | undefined): string | null {
    if (!source.endsWith('.module.css')) return null
    const absolute = importer === undefined ? source : resolve(dirname(importer), source)
    // Store a relative path: rolldown writes this virtual id verbatim into the output's
    // chunk comments, so an absolute path would publish the build machine's directory
    // layout into a public repository.
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
       * 🔴 Not [hash]: lightningcss's hash has a nondeterministic component, so two builds
       * of identical source produce different class names. Two consequences — lib/ is
       * committed (git-source installs depend on it), so every build adds dozens of lines
       * of pure-noise diff; and CI's "does the build match what was committed" gate would
       * be permanently red, which is the same as not having it.
       *
       * Package name + file name instead: deterministic, reproducible, still scoped per
       * file, and it cannot collide with the host or another plugin.
       */
      cssModules: { pattern: 'dshmkt-[name]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    // Sort by key: lightningcss's exports iterate in an unstable order, so writing them
    // straight out gives a differently ordered class map on every build of identical
    // source — more pure-noise diff
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
     * Bundle dependencies in, so the output has zero runtime dependencies.
     *
     * Distribution dictates this: after cloning, users run `pnpm add <local directory>`,
     * which only creates a symlink and never installs that directory's own dependencies —
     * so the host half's `import 'yaml'` finds nothing and dsh fails to start. Bundling
     * removes the problem, and the package works the same via clone, npm or tarball.
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
    // The output is committed; sourcemaps are half the size and useless to consumers.
    sourcemap: false,
    // The host half was just written to lib/; cleaning again here would delete it.
    clean: false,
    external: EXTERNALS,
    // tsdown externalises dependencies by default, but the module table cannot answer for
    // anything beyond react — inline everything not in EXTERNALS, or require throws at
    // runtime.
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
