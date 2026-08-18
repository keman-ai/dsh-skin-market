/**
 * harness 侧 API 的最小类型面 —— 本插件用到的那部分，照 deepseek-harness
 * 0.1.0-rc.7 的源码抄写。
 *
 * 为什么自带而不是依赖 @deepseek-ai/* ：
 *   1. 这些模块在运行时全是 external，由宿主的模块表注入（见 tsdown.config.ts
 *      的 EXTERNALS），插件包里不会、也不该打进它们的实现；
 *   2. npm 上的 @deepseek-ai/dsh-client-* 依赖链目前不完整（dsh-compact 未发布），
 *      装不下来；
 *   3. 开源仓库让贡献者 `pnpm i` 就能编译，不必先备齐一套 rc 包。
 *
 * 代价是这份声明可能与宿主漂移。约束：只声明真正用到的成员，每处标注源码位置，
 * 宿主报错时先回来核对这里。
 */

declare module '@deepseek-ai/cordis' {
  /** 释放函数：cordis 里所有注册类 API 的统一返回。 */
  export type Disposer = () => void

  /** packages/host/webserver/src/index.ts */
  export interface WebRoute {
    /** 'exact' 精确匹配路径；'prefix' 匹配 p 与 p/<任意>。 */
    kind: 'exact' | 'prefix'
    /** 绝对路径，不带结尾斜杠。 */
    path: string
    /** 完全接管响应生命周期（可以挂住不关，例如 SSE）。 */
    handler: (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => void | Promise<void>
  }

  /** packages/host/webserver/src/index.ts —— 浏览器 HTTP 载体。 */
  export interface WebServer {
    register(route: WebRoute): Disposer
    tapIndex(transform: (html: string) => string): Disposer
  }

  export interface Logger {
    info(message: unknown, ...args: readonly unknown[]): void
    warn(message: unknown, ...args: readonly unknown[]): void
    error(message: unknown, ...args: readonly unknown[]): void
  }

  /** 插件 apply 收到的上下文（本插件用到的成员）。 */
  export interface Context {
    /** 浏览器 HTTP 载体；用 ctx.inject(['webServer'], …) 等它就绪。 */
    webServer: WebServer
    logger: Logger
    /**
     * 配置树锚点 —— cordis.yml 所在目录，也就是 profile 目录。
     * 见 packages/client/modules/src/index.ts:209。
     */
    baseUrl?: string
    /** 注册一份需要清理的资源，返回其 disposer。 */
    effect(setup: () => Disposer, label?: string): Disposer
    /** 等待服务就绪后再跑回调。 */
    inject(services: readonly string[], callback: (ctx: Context) => void): void
    /** 读一个可能不存在的服务。 */
    get<T = unknown>(name: string): T | undefined
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { Context, Disposer } from '@deepseek-ai/cordis'
  import type { ComponentType } from 'react'

  /** slots.register 的登记项（本插件用到的字段）。 */
  export interface SlotRegistration {
    /** 目标 slot 名。 */
    name: string
    /** list-kind slot 的条目 id。 */
    id?: string
    /** 同一 slot 内的排序，小的在前。 */
    order?: number
    /** 由注册方自行本地化的显示文本。 */
    label?: () => string
    /** 该条目文案所属的词典命名空间。 */
    locale?: string
    /** 业务面工厂：返回值作为 props 注入组件。 */
    inject?: () => unknown
    /** 本条目声明的子 slot。 */
    children?: Record<string, { kind: 'list' | 'keyed' | 'single' | 'chain'; scope: 'root' | 'session' }>
  }

  /** 浏览器侧的 slot 注册表。 */
  export interface SlotsService {
    /** 跟随 slot 的延迟声明/重新声明注册，无需 import slot 拥有方。 */
    inject(name: string, factory: () => Disposer): void
    register(registration: SlotRegistration, component: ComponentType<never>): Disposer
    entries(name: string): readonly { options: SlotRegistration }[]
    getVersion(name: string): number
    subscribe(name: string, listener: () => void): Disposer
  }

  /** 词典服务。 */
  export interface LocaleService {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): Disposer
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
    subscribe(listener: () => void): Disposer
    getSnapshot(): { revision: number }
  }

  /** 浏览器插件上下文。 */
  export interface ClientContext extends Context {
    slots: SlotsService
    locale: LocaleService
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  // 只为把设置外壳的 slot 声明（settings.section 等）拉进编译面，无值导出。
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  // 同上：拉入 ctx.locale 的 Context 合并。
}
