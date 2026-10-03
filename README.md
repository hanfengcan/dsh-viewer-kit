# dsh-viewer-kit

给 DeepSeek Harness（`dsh`）对话窗口用的**可插拔内容渲染层**。

模型输出 ` ```html ` 时，代码块头部会出现一个切换按钮，可以在 **预览**（沙箱 iframe
真实渲染）和 **代码**（DSH 原生高亮）之间来回切。同一套机制已经接好了数据表格渲染器，
后面要加 ECharts、流程图、代码高亮增强，只需要在 `src/client/renderers/` 下加一个文件。

```
┌─────────────────────────────────────────────────────────────┐
│ HTML   [预览│代码]  →  沙箱 iframe                          │
│ SVG    [预览│代码]  →  沙箱 iframe                          │
│ CSV    [表格│代码]  →  原生 table 元素                      │
│ JSON   [表格│代码]  →  只认对象数组                          │
│ py     （原样，不打扰）                                      │
└─────────────────────────────────────────────────────────────┘
```

> 上面这四行里的后两行（CSV / JSON）是在 HTML 之后单独加进去的，
> 当时内核、接缝、surface 三层一行都没改，也没有新增任何 DOM 钩子。
> 这就是这套架构想保证的性质。

---

## 先读这个

**架构设计文档在 [`docs/01-architecture.md`](docs/01-architecture.md)。**
里面记录了接入点是怎么选出来的、为什么否决了另外两条路、每一条平台事实的证据位置，
以及已知风险。代码是照着那份文档写的，文档和代码不一致时以代码为准、以文档为准请开 issue。

**加一个新渲染器看 [`docs/02-renderer-authoring.md`](docs/02-renderer-authoring.md)。**

---

## 快速开始

构建走 **tsdown** —— 和官方 `dsh-experimental-client-ui-voice-input` 与社区 `dshmarket`
同一条管线，产物是 DSH 客户端模块系统要求的 `window.__ModuleLoader__.load({ id, factory })`
经典脚本格式。

```powershell
pnpm install

# 类型检查 → 构建 → 测试
pnpm run check

# 或者分开
pnpm run typecheck   # tsc --noEmit，检查 src/**/*.js 上的 JSDoc
pnpm run build       # tsdown → client/client.js；scripts/build-host.mjs → lib/index.js
pnpm test            # 40 项：核心逻辑 + 接缝夹具 + 产物本身
```

### Node 版本

tsdown 需要 **Node ≥ 22**（`Promise.withResolvers`）。仓库用 `.node-version` 声明 `24`，
并用 `package.json` 的 `engines.node` 兜底。

**为什么必须显式管版本**：`pnpm run` / `pnpm exec` 是用 **PATH 上的 `node`** 拉起
子进程的，而本机 PATH 上是不受控的旧版本（实测 v20.19.5），
会直接报 `Promise.withResolvers is not a function`。
用 `fnm` 选定版本即可，而且 `fnm exec` 能把版本**穿透**到 pnpm 拉起的嵌套进程
（已验证：嵌套层拿到 v24.12.0）：

```powershell
# 交互式终端：装了 fnm 且 shell profile 里有 `fnm env --use-on-cd`，
# 进入本目录会自动切到 .node-version
fnm use

# 脚本 / 非交互式（不依赖 shell 设置）
fnm exec --using=24 -- pnpm run check

# 一行确认
fnm exec --using=24 -- pnpm exec node -v   # 应输出 v24.x
```

## 安装到 profile

**只用插件管理器的正式渠道，永远不要手改 profile 的 `cordis.patch.yml`。**
手改的那一行是 Loader 的**生成物**；下一次任何 `dsh plugin add` 都会重写整个 patch 文件，
那一行就没了，插件静默消失（本项目真的这样翻过一次车，见架构文档 §13.4）。

```powershell
# 命令行（等价于在 profile 目录里跑 pnpm add）
dsh plugin --profile desktop add file:E:\1.i-code\0.dsh-workplace\dsh-viewer-kit
```

或从会话里用 `plugin_manager` 工具的 `install_bundle`。装完它出现在 profile
`package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里；Loader 那一行由包自己的
`dsh.bundle.patch` 再生，之后同样的安装操作不会再把它冲掉。

装完**刷新一次页面**即可；宿主侧通过 `app-boot/config-reload` 热加载，不需要重启 DSH。

> **改完代码必须重新安装，光 `pnpm run build` 不够。**
> pnpm 把 `file:` 目录依赖**拷贝**进 profile 的 `node_modules`（不是硬链接——我用追加探针
> 标记的实验证伪过）。所以 profile 里那份 `client/client.js` 停在**安装那一刻**的内容，
> 而且**任何地方都不会报错**。开发循环是：
>
> ```
> pnpm run build  →  重新安装  →  刷新页面
> ```
>
> `install_bundle` 在 lockfile 未变时会回 `Already up to date` 并**拒绝重装**；
> 要真正同步，先 `remove_bundle` 再 `install_bundle`，或者提升 `version`。
日志里应该出现：

```
[dsh-viewer-kit] renderers: html, table
[dsh-viewer-kit] v0.3.1 active — N code block(s) enhanced
```

浏览器控制台里可以直接查状态：

```js
__DSH_VIEWER_KIT__.diagnose()
```

`diagnose()` 是排查"装了但没渲染"的**唯一一条命令**，它把三种情况区分开：

| 现象 | 含义 |
|---|---|
| `__DSH_VIEWER_KIT__` 是 `undefined` | 客户端半体**根本没加载** → 硬刷新页面（`Ctrl+Shift+R`） |
| `blocks: 0` | 插件活着，但页面上一个 `.md-code-block` 都没有 → 那段报告不是围栏代码块（可能是 `present` 工具卡片或附件，v0 不覆盖，见架构文档 §7.2） |
| `blocks > 0` 且 `unclaimed` 含你的语言 | 找到了但没被认领 → 看 `languages` 里实际是什么 |
| `settled < blocks` | 还没稳定（流式未结束），稍等再跑一次 |
| `enhanced > 0` | 已经在工作，去看代码块头部有没有切换按钮 |

> **不要手改 profile 的 `cordis.patch.yml`。**
> 本插件最初就是那样装的，当时确实热加载成功了；但下一次有人跑 `dsh plugin add` 时
> 整个 patch 文件被重写，那一行就没了，插件静默消失。
> 走 `dsh plugin add` 之后它进了 profile `package.json` 的 `dependencies`
> 和 `dsh.profile.bundles`，同样的操作不会再把它冲掉。
> 复盘见 [`docs/01-architecture.md` §13](docs/01-architecture.md#13-已被实证的部分)。

## 配置

插件的所有可调项都是**插件配置**，写在 Loader 行的 `config` 里。
本插件**没有**导出 `Config` schema —— cordis 因此把 `config` 原样转发给
`apply(ctx, config)`（见 `@deepseek-ai/cordis` 的 `resolveConfig`：
`if (!runtime.Config) return config`），客户端半体再用 `resolveConfig` 逐字段校验：
未知键丢弃、类型不符的值**退回默认值**而不是让 entry 失败 —— entry 失败就是 web boot 失败。

要改默认行为（对**当前这个 profile** 生效），编辑 profile 自己的 patch：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: dsh-viewer-kit
  config:
    htmlAllowScripts: true
```

用户 patch 在所有组合包层**之后**应用，按行 id 胜出，所以这样写会覆盖包内的默认值。
改完刷新页面即可，配置变更会触发热替换，不必重启。

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `defaultToPreview` | `true` | 认领到的代码块默认打开**预览**而不是源码 |
| `htmlAllowScripts` | `false` | 允许预览里的 HTML 执行脚本（图表等） |
| `maxPreviewHeight` | `520` | 内嵌预览的最大高度（CSS 像素） |
| `maxSourceBytes` | `262144` | 超过这个字节数的源码保持原生代码块，不交给渲染器 |
| `disabledRendererIds` | `[]` | 按 id 关闭个别渲染器，无需卸载 |

### 关于 `htmlAllowScripts`

默认关闭，所以带 `<script>` 的 HTML（ECharts 等图表）在预览里**是空白的** ——
需要时按上面的方式打开即可。

打开后 iframe 仍然是**不透明源**：`allow-scripts` 单独授予，**绝不**与
`allow-same-origin` 同时出现（那才是真正的逃逸），所以文档依然读不到宿主的 DOM、
cookie 或 storage。变化的是：**仅仅渲染一段内容，就可能发起该内容里的网络请求**
（远程图片被自动加载、脚本可向任意地址发请求）。内容本身是模型写的，泄露面基本限于
模型已写出的东西，但"看一眼就联网"确实是新引入的能力。测试里有一条专门守着
`allow-same-origin` 永远不被授予。

> DSH 确实有配置界面（`dsh-settings` + `dsh-config-editor`），但按其 README：
> 表单只暴露标了 `.volatile()` 的字段，且**目前没有任何客户端实现按 schema 自动生成表单**。
> 所以现阶段开关就是上面这段 patch 文本，不是界面里的一个勾。

改完刷新后，控制台这行会打印**实际生效**的配置，可用来确认：

```
[dsh-viewer-kit] config: default view=preview, html scripts=on, max preview height=520px
```

---

## 分发给别人

依据官方《[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)》，
组合包的 manifest 只需声明 `dsh.bundle.patch`，指向包内一个按**包名**引用自身的 patch：

```jsonc
// package.json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // 这个包贡献哪一层
  "client": { "platform": "web" }                // 这个包有客户端半体
}
```
```yaml
# cordis.patch.yml —— 行里写包名，Node 的模块解析才找得到已安装的代码
- insert:
    - id: dsh-viewer-kit
      name: 'dsh-viewer-kit'
```

**两条不需要任何构建授权的路线**（推荐其一）：

```powershell
# A. 交付 tarball —— 用户直接装这个文件
npm pack                                  # prepack 已配好，会自动构建
dsh plugin --profile desktop add ./dsh-viewer-kit-0.3.1.tgz

# B. 发布到 npm —— 同样在 publish 阶段构建好产物
npm publish
dsh plugin --profile desktop add dsh-viewer-kit
```

**不要走 `github:` 直装。** 官方文档明确警告：git 安装拉的是**源码不是产物**，
pnpm ≥10 会拒绝运行它的 `prepare` 脚本，除非用户在 profile 的 `pnpm-workspace.yaml`
里写 `allowBuilds` —— 那等于**允许该包的代码在安装时于本机执行、且不在任何沙箱内**。
分发预构建产物就没有这道坎。

### 发布前自检

```powershell
pnpm run preflight     # 打包 → 解包到临时目录 → 校验 → 清理
pnpm run release       # check + preflight，完整发布门禁
```

`preflight` 校验的是**用户真正拿到的那份字节**，而不是工作树：manifest 的三个声明、
`exports["./client"]` 是否真能解析（解析不到就是 `MissingClientBundleError`，
而渲染进程的 boot 审计会把 entry 失败判成**启动失败**）、host 半体能否 import，
并让解出来的客户端 bundle 在严格 `ctx` 下真实激活一次。
`tools/preflight.mjs <已解包目录>` 可以对任意解包结果单独跑。

> 写这个自检时我特意做了**负向测试**：把 `client/client.js` 改名、把 patch 行写成别的包名、
> 删掉 `dsh.bundle` 声明 —— 三种破坏都被精确报出。一个不会失败的检查比没有检查更坏，
> 这正是本项目崩过两次的根因（见架构文档 §13.6）。

---

## 它是怎么工作的

DSH 的 markdown 渲染器是封闭的，没有留给插件的节点扩展点
（`docs/01-architecture.md` §2.3 有逐行证据）。所以本插件**不注册任何 Slot、
不重写任何 DSH 组件**，只在 DSH 自己标注为"给消费者用"的稳定节点上挂东西：

```html
<div class="… md-code-block">
  <div data-code-block-banner>          ← 官方 CSS 注释：stable content node
    <div>…语言名…</div> <div>…换行/复制…</div>   我们把切换控件追加到这里
  </div>
  <div data-code-block-content>         ← 官方 CSS 注释：stable content node
    <div class="shiki"><pre>…</pre></div>         原生代码，保持原样
    <div data-dvk-root>                 ← 我们追加的渲染结果
  </div>
</div>
```

切换视图时**只改一个我们自己的属性**（`data-dvk-mode`），由插件自己的样式表决定谁可见。
原生 `<pre>` 一个字节都没动过，所以切回代码是零失真的。

由此带来的几条硬性质：

| 性质 | 怎么做到的 |
|---|---|
| 零破坏性 | 不注册 Slot、不 shadow 任何已注册的 key |
| 卸载即复原 | 所有清理挂在 `ctx.effect` 的 disposer 上；`dispose()` 只删自己加的节点 |
| 不打断流式输出 | 流式期间内容节点的子元素是 `<pre>`，稳定后变成 `<div>`——这是免费的"已结束"信号 |
| 换掉接缝不影响渲染器 | 接缝只产出 `RenderRequest`，Kit 与渲染器不知道 DOM 存在 |

---

## 目录

```
src/client/
  index.js             入口：apply(ctx)，装 Kit → 注册渲染器 → 装样式 → 起接缝
  contract.js          共享词汇：RenderRequest / Renderer / 指纹 / 语言归一化
  kit.js               注册表 · 协商 · 视图状态 · 统计（零 DOM）
  view-state.js        按内容指纹记忆视图选择（sessionStorage，可降级）
  dom-contract.js      ★ 唯一记录 DSH DOM 契约的地方（升级时只核对这里）
  dom-seam.js          L1 发现 / 回收 / 流式守卫
  code-block-surface.js L3 一个 surface = 一个代码块
  renderers/html.js    L5 HTML / SVG 沙箱预览
  renderers/table.js   L5 CSV / JSON 数组 / 管道表格
  locale.js  styles.js
src/index.js           Host 半体（仅作为 Loader 行的落点，v0 无行为）
tests/                 49 项测试 + DOM 垫片 + 从 DSH 真实产物抄来的夹具
scripts/build-host.mjs 把 Host 半体拷到 lib/（客户端半体由 tsdown 打包）
tools/                 asar 读取脚本：升级 DSH 后用来复核 DOM 契约
docs/                  架构设计 / 渲染器作者指南
tsdown.config.ts       ★ 客户端 bundle 的构建契约（模块系统格式在这里定义）
```

> `package.json` 的 `files` 只发布 `lib/ client/ src/ docs/`，因为装进 profile 的只需要这些。
> `tests/ scripts/ tools/` 与 `tsdown.config.ts` 是仓库内的工作流，跟宿主无关，所以不发布。

> **构建产物 `client/client.js` 与 `lib/index.js` 是提交进版本库的**，这与"不提交产物"的常规
> 做法不同，是有意的：本仓库就是被 `pnpm add file:<path>` 安装的那一份。
> DSH 的客户端模块系统在激活时会直接 `readFileSync` 这个 bundle，缺文件会抛
> `MissingClientBundleError` 并让整个 entry 激活失败（渲染进程的 boot 审计会因此判定启动失败）。
> 提交它们，新克隆的树才开箱可装。改完源码务必重新 `pnpm run build` 再提交。

## 升级 DSH 之后

（这几步在**本仓库**里做，不需要动装进 profile 的那份。）

1. 跑 `tools/asar-extract.ps1 -Path dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js`
   把新的 `CodeBlock` 抽出来（`tools/README.md` 里有 asar 头部格式的坑）；
2. 核对 `src/client/dom-contract.js` 里引用的行号和 DOM 形状；
3. `pnpm run check` —— 类型检查、构建、夹具与断言会告诉你变了什么；
4. 重新安装（见上文"安装到 profile"），让宿主拿到新的 `client/client.js`。

## 安全

模型产出的 HTML 属于不可信输入。预览一律走 `<iframe sandbox>`：

- 默认 `sandbox=""`（完全禁脚本），开脚本需要显式配置 `htmlAllowScripts`；
- **任何配置下都不会同时给 `allow-scripts` 和 `allow-same-origin`**；
- `referrerpolicy="no-referrer"`；
- v0 **不提供**"在新标签页打开"——那会用 `blob:` URL 以宿主同源执行，恰好绕开全部沙箱保证。

## 许可

MIT
