# dsh-skin-market

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的皮肤市场插件：在设置里搜社区皮肤，点一下装上，刷新页面就换了皮。

皮肤目录来自 [dsh.a2hmarket.ai](https://dsh.a2hmarket.ai)，免登录。

![设置 → 皮肤市场：发现页，搜索社区皮肤并一键安装](plugin.png)

```
设置 → 皮肤市场
├─ 发现      搜索 · 排序 · 一键安装
├─ 已安装    版本 · 来源 · 卸载（读本机 profile，断网可用）
└─ 诊断      pnpm · profile 路径 · 集市连通性 · 上次安装输出
```

## 安装

尚未发布到 npm，从源码装：

```sh
git clone https://github.com/keman-ai/dsh-skin-market.git
cd dsh-skin-market
pnpm install
pnpm build

dsh plugin --profile web add -w "$PWD"
```

然后重启 dsh，打开 **设置 → 皮肤市场**：

```sh
dsh --profile web
```

从 harness 源码运行的话，把上面两条 `dsh` 换成在 harness 目录里跑 `pnpm dsh`。

> **`-w` 不能省。** profile 目录自带 `pnpm-workspace.yaml`，pnpm 因此认定它是 workspace 根并拒绝安装（`ERR_PNPM_ADDING_TO_ROOT`）。`-w` 就是"我确实要装到根"的声明；`dsh plugin` 会把它原样转发给 pnpm。pnpm 8 和 10 都需要。

发布到 npm 之后，上面整段会简化成一行 `dsh plugin --profile web add -w dsh-skin-market`。

### 卸载

```sh
dsh plugin --profile web remove dsh-skin-market
```

用市场装的皮肤不会跟着消失 —— 它们是 profile 里独立的依赖，要单独卸（市场页的「已安装」里点卸载，或同样用 `dsh plugin remove`）。

## 运行环境

**只逛**只要有 dsh 和网络。**要装皮肤**才需要那几个命令行工具，因为安装本质上就是替你跑 `pnpm`。

| 依赖 | 要求 | 少了会怎样 |
|---|---|---|
| **DeepSeek Harness** | `0.1.0-rc.6+`（实测 rc.7） | 更早的版本没有 `settings.section` 与浏览器模块表，插件挂不上 |
| **profile** | 必须是 **web** profile | headless / tui 组合里没有 `webServer`，插件不会激活 |
| **Node.js** | `>= 20`（实测 24） | dsh 自己的要求，插件不额外抬高 |
| **pnpm** | 在 `PATH` 上（实测 8.15 与 10） | 只影响安装。诊断页标红，安装按钮明确报错，浏览和搜索照常 |
| **git** | 在 `PATH` 上 | 目录里多数皮肤是 `github:owner/repo` 源，pnpm 靠 git 拉 |
| **网络** | `dsh.a2hmarket.ai`；装 GitHub 源皮肤还要 `github.com` | 集市连不上会回落到缓存 / 随包快照并在页面说明 |
| **浏览器** | 装皮肤要求**本机直连**（loopback） | 远程访问时能逛能搜，安装被拒 |

插件自身只有一个运行时依赖：[`yaml`](https://www.npmjs.com/package/yaml)，用来读写 profile 的 patch 文件。

## 装完为什么不用重启

装一个皮肤时，插件把该皮肤包声明的那层 patch 内联进 **profile 的 `cordis.patch.yml`**（用户层），而不是 `dsh plugin` 用的 `dsh.profile.bundles`。用户层被 app-boot 的 `watchUserPatches` 持续监视，写完约一秒内 Loader 树就事务式热重组，新插件的 host 半直接挂上；浏览器侧刷新页面即可加载它的 bundle。

进程始终不重启。只有插件**自身**的安装需要重启一次 dsh，此后所有皮肤都在界面里点。

## 配置

插件默认不需要配置。要改的话，在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/cordis.patch.yml`）里追加一段，按 id 覆盖本插件那一行：

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

改完代码重新 `pnpm build`，然后重启 dsh。插件是以 `link:` 装进 profile 的，不必重新 `add`。

### 两半

| | 文件 | 职责 |
|---|---|---|
| host | `src/index.ts` | 在 `ctx.webServer` 上挂 `/skin-market/api/*`：目录代理与缓存、已装清单、安装/卸载（SSE 回流 pnpm 输出）、诊断 |
| client | `src/client/index.ts` | 注册 `settings.section`，画列表、搜索、安装交互 |

两半之间走**同源 HTTP**，不走 `ctx.remote` —— remote 的能力集在 `api-remotes` 构建期就固定了，第三方插件加不进去。

`lib/client.js` 是闭包工厂形态的 CJS（`window.__ModuleLoader__.load({ id, factory })`），React 等外部依赖由宿主注入的 `require` 从模块表取，不打进包里。这个形状由 dsh 的模块表规定，`tsdown.config.ts` 复刻了它。

### harness 的类型

`types/dsh.d.ts` 自带了用到的那部分 harness API 声明，照 0.1.0-rc.7 的源码抄写，每处标了出处 —— 这些模块运行时全是 external，而 npm 上的 `@deepseek-ai/dsh-client-*` 依赖链目前不完整装不下来。宿主行为与声明对不上时，先回那个文件核对。

## 相关

[dsh.a2hmarket.ai](https://dsh.a2hmarket.ai) —— 皮肤目录站，作者在这里上架。本插件的目录就是从这里拉的。

![DSH 皮肤集市：社区皮肤一览，看效果、读说明、复制一行命令装上](market.png)

## 许可

[MIT](LICENSE) © 2026 Science Roam Limited
