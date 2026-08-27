/**
 * The minimal type surface of the harness API — the part this plugin uses, transcribed
 * from the deepseek-harness 0.1.0-rc.7 source.
 *
 * Why vendored instead of depending on @deepseek-ai/*:
 *   1. these modules are external at runtime, injected by the host's module table (see
 *      EXTERNALS in tsdown.config.ts) — the plugin neither bundles nor should bundle them;
 *   2. the @deepseek-ai/dsh-client-* dependency chain on npm is incomplete (dsh-compact is
 *      unpublished), so it cannot be installed;
 *   3. contributors can compile straight after `pnpm i`, with no rc packages to assemble first.
 *
 * The cost is that these declarations can drift from the host. The rule: declare only what
 * is actually used, note the source location at each site, and check here first when the
 * host errors.
 */

declare module '@deepseek-ai/cordis' {
  /** Disposer: what every registration API in cordis returns. */
  export type Disposer = () => void

  /** packages/host/webserver/src/index.ts */
  export interface WebRoute {
    /** 'exact' matches the path exactly; 'prefix' matches p and p/<anything>. */
    kind: 'exact' | 'prefix'
    /** Absolute path, without a trailing slash. */
    path: string
    /** Takes full ownership of the response lifecycle (may stay open, e.g. for SSE). */
    handler: (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => void | Promise<void>
  }

  /** packages/host/webserver/src/index.ts — the browser HTTP carrier. */
  export interface WebServer {
    register(route: WebRoute): Disposer
    tapIndex(transform: (html: string) => string): Disposer
  }

  /** cordis's Logger facade is `Record<'error'|'info'|'warn'|'debug', LoggerMethod>`; only what we use is listed. */
  export interface Logger {
    info(message: unknown, ...args: readonly unknown[]): void
    warn(message: unknown, ...args: readonly unknown[]): void
    error(message: unknown, ...args: readonly unknown[]): void
    /** Anything the user need not act on goes here — do not pollute normal logs with warn. */
    debug(message: unknown, ...args: readonly unknown[]): void
  }

  /** The context a plugin's apply receives (only the members this plugin uses). */
  export interface Context {
    /** The browser HTTP carrier; await it with ctx.inject(['webServer'], …). */
    webServer: WebServer
    logger: Logger
    /**
     * The config-tree anchor — the directory holding cordis.yml, i.e. the profile directory.
     * See packages/client/modules/src/index.ts:209.
     */
    baseUrl?: string
    /** Register a resource needing cleanup; returns its disposer. */
    effect(setup: () => Disposer, label?: string): Disposer
    /** Run the callback once the services are ready. */
    inject(services: readonly string[], callback: (ctx: Context) => void): void
    /** Read a service that may not exist. */
    get<T = unknown>(name: string): T | undefined
    /** Subscribe to an event; returns the unsubscribe function. */
    on(event: string, listener: (...args: never[]) => void): Disposer
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { Context, Disposer } from '@deepseek-ai/cordis'
  import type { ComponentType } from 'react'

  /** A slots.register entry (only the fields this plugin uses). */
  export interface SlotRegistration {
    /** Target slot name. */
    name: string
    /** Entry id for a list-kind slot. */
    id?: string
    /** Ordering within a slot; lower comes first. */
    order?: number
    /** Display text, localised by the registrant. */
    label?: () => string
    /** The locale namespace this entry's copy belongs to. */
    locale?: string
    /** Domain factory: its return value is injected into the component as props. */
    inject?: () => unknown
    /** Child slots declared by this entry. */
    children?: Record<string, { kind: 'list' | 'keyed' | 'single' | 'chain'; scope: 'root' | 'session' }>
  }

  /** The browser-side slot registry. */
  export interface SlotsService {
    /** Registers following the slot's late or repeated declaration, with no import of the slot's owner. */
    inject(name: string, factory: () => Disposer): void
    register(registration: SlotRegistration, component: ComponentType<never>): Disposer
    entries(name: string): readonly { options: SlotRegistration }[]
    getVersion(name: string): number
    subscribe(name: string, listener: () => void): Disposer
  }

  /** Locale service. */
  export interface LocaleService {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): Disposer
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
    subscribe(listener: () => void): Disposer
    getSnapshot(): { revision: number }
  }

  /** One selectable theme: id, base palette, and alias token overrides. */
  export interface ThemeDefinition {
    id: string
    colorScheme: 'light' | 'dark'
    tokens: Record<string, string>
  }

  /** The immutable snapshot the theme service publishes on every change. */
  export interface ThemeSnapshot {
    /** The persisted preference, possibly `system`. */
    preference: string
    /** The resolved current theme. */
    active: ThemeDefinition
    /** Registered themes, including the built-in light / dark and any registered by skins. */
    themes: readonly ThemeDefinition[]
    revision: number
  }

  /**
   * Theme registry. A skin plugin registers its theme in its own apply, but dsh's
   * Appearance row renders only the three built-ins and never lists third-party themes —
   * leaving no UI that can select it. Filling that gap is exactly what the market does:
   * list the registered themes so the user can pick one.
   */
  export interface ThemeRuntime {
    getTheme(): ThemeSnapshot
    /** Change the preference. Pass a registered theme id or `system`; an unregistered id throws. */
    setTheme(id: string): void
  }

  /** Browser plugin context. */
  export interface ClientContext extends Context {
    slots: SlotsService
    locale: LocaleService
    /** Provided by ui-theme; without it in the bundle, `ctx.get('theme')` returns undefined. */
    theme?: ThemeRuntime
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  // Type-only, purely to bring the settings shell's slot declarations (settings.section etc.) into the compilation surface.
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  // As above: brings in the ctx.locale Context merge.
}
