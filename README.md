# dsh-skin-market

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的皮肤市场插件：在设置里搜社区皮肤，点一下装上。

皮肤目录来自 [dsh.a2hmarket.ai](https://dsh.a2hmarket.ai)，免登录。

```
Settings → 皮肤市场
├─ 发现      搜索 · 排序 · 一键安装
├─ 已安装    版本 · 来源 · 卸载（读本机 profile，断网可用）
└─ 诊断      pnpm · profile 路径 · 集市连通性 · 上次安装输出
```

## 运行环境

分两档：**只逛**只要有 dsh 和网络；**要装皮肤**才需要下面那几个命令行工具，因为安装本质上就是替你跑 `pnpm`。

| 依赖 | 要求 | 少了会怎样 |
|---|---|---|
| **DeepSeek Harness** | `0.1.0-rc.6+`（实测 `0.1.0-rc.7`） | 更早的版本没有 `settings.section` 与浏览器模块表，插件挂不上 |
| **profile** | 必须是 **web** profile | 市场页是浏览器界面，headless / tui 组合里没有 `webServer`，插件不会激活 |
| **Node.js** | `>= 20`（实测 24） | dsh 本身的要求，插件不额外抬高 |
| **pnpm** | 在 `PATH` 上（实测 8.15；10+ 亦可） | 只影响安装：诊断页会标红，安装按钮点下去明确报 `pnpm 不在 PATH`，浏览和搜索不受影响 |
| **git** | 在 `PATH` 上 | 目录里多数皮肤是 `github:owner/repo` 源，pnpm 靠 git 拉取；没有 git 就只能装 npm 源的皮肤 |
| **网络** | 能访问 `dsh.a2hmarket.ai`；装 GitHub 源皮肤还需能访问 `github.com` | 集市连不上会自动回落到本地缓存 / 随包快照，并在页面上说明；github 不通则该皮肤装不了 |
| **浏览器位置** | 装皮肤要求**本机直连**（loopback） | 远程访问 dsh 时可以逛可以搜，安装会被拒（见「安全边界」） |

插件自身只有一个运行时依赖：[`yaml`](https://www.npmjs.com/package/yaml)（读写 profile 的 patch 文件，随包安装）。React、cordis 等一律由宿主的模块表注入，插件不打包也不重复安装。

pnpm 10 起，安装 git 源的包默认拒绝执行其构建脚本。市场不会替你绕过这条，只会在需要时问你要一次明确授权 —— 细节见下面的安全边界。

## 安装

```sh
dsh plugin --profile web add dsh-skin-market
```

装完重启一次 dsh。**此后所有皮肤都在界面里点，不用再敲命令。**

## 一键安装是怎么做到不重启的

装一个皮肤走的是这条路径：

1. host 半用 `ctx.baseUrl` 定位 profile 目录（配置树锚点就是它，不用猜 `$DSH_HOME/profiles/<name>`）；
2. `pnpm add <spec>`，cwd 就是该目录；
3. 把插件行追加进 **profile 的 `cordis.patch.yml`**（用户层），而不是 `dsh plugin` CLI 用的 `dsh.profile.bundles` —— 前者被 app-boot 的 `watchUserPatches` 持续监视，写完约 1 秒内 Loader 树事务式热重组；
4. 新包名此前没被判定过，`clientModules` 会真去读它的 package.json，读到 `dsh.client` 就进图；
5. 界面提示「刷新页面生效」。

全程不重启进程。

## 安全边界

这个插件会在你的机器上跑 `pnpm`，所以边界写在明处：

| 面 | 处置 |
|---|---|
| 谁能装 | 只有**本机直连**的浏览器。带了 `x-forwarded-*` 的请求一律拒绝 —— 反代转进来的请求 socket 看着也是 127.0.0.1，只认地址会把这条保证架空 |
| 装什么 | 只装 dsh.a2hmarket.ai 收录过的 spec，手输任意包名不放行 |
| 构建脚本 | 保持 pnpm 默认拒绝。需要时弹确认讲清楚「这等于允许该包代码在你机器上执行，且不在 agent 沙箱内」，同意后才写 `allowBuilds` 并重试 —— 不代写、不静默 |
| 装失败 | 事务化：`pnpm add` 成功了才写 patch 行；写行失败就把包卸回去。不留半装状态 |
| 改配置 | 只动 `id` 以 `skin:` 开头的行。你自己写的行和注释原样保留；patch 文件不是条目数组时直接报错，不覆盖 |
| 自动重启 | 不做。dsh 是前台 CLI，替你杀掉再拉起会丢会话和终端状态 |

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖本插件那一行：

```yaml
- id: skin-market
  name: dsh-skin-market
  config:
    # 换一个集市（自建目录服务时用）。注意要带 context-path。
    catalogOrigin: https://dsh.a2hmarket.ai/dsh-skin
    # 关掉后市场只读：能逛能搜，安装按钮不再动你的机器。
    allowInstall: true
```

## 开发

```sh
pnpm install
pnpm build     # → lib/index.js（host 半）+ lib/client.js（浏览器半）
pnpm check     # 类型检查
pnpm test      # 单元测试
```

本地挂进一个 dsh checkout：

```sh
dsh plugin --profile web add /path/to/dsh-skin-market
```

### 两半

| | 文件 | 职责 |
|---|---|---|
| host | `src/index.ts` | 在 `ctx.webServer` 上挂 `/skin-market/api/*`：目录代理与缓存、已装清单、安装/卸载（SSE 回流 pnpm 输出）、诊断 |
| client | `src/client/index.ts` | 注册 `settings.section`，画列表、搜索、安装交互 |

两半之间走**同源 HTTP**，不走 `ctx.remote` —— remote 的能力集在 `api-remotes` 构建期就固定了，第三方插件加不进去。

`lib/client.js` 是闭包工厂形态的 CJS（`window.__ModuleLoader__.load({ id, factory })`），外部依赖由宿主注入的 `require` 从模块表取。这个形状由 dsh 的模块表规定，`tsdown.config.ts` 里复刻了它。

### harness 的类型

`types/dsh.d.ts` 里自带了用到的那部分 harness API 声明，照 0.1.0-rc.7 的源码抄写，每处标了出处。这样做是因为：这些模块运行时全是 external（由宿主模块表注入），npm 上的 `@deepseek-ai/dsh-client-*` 依赖链目前不完整装不下来，而且贡献者 `pnpm i` 就能编译，不必先备齐一套 rc 包。

宿主行为与声明对不上时，先回那个文件核对。

## 相关

[dsh.a2hmarket.ai](https://dsh.a2hmarket.ai) —— 皮肤目录站，作者在这里上架。

MIT
