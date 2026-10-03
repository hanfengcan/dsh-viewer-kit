# dsh-viewer-kit

给 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（`dsh`）对话窗口用的
**可插拔内容渲染层**：让代码块除了「源码」之外还能有「渲染结果」，两者一键切换。

> **这是一个 vibe coding 项目。** 代码绝大部分由 AI 在对话中生成，作者负责提需求、验证结果、
> 以及在它跑偏时把方向纠回来。它能工作、有测试，但**依赖前请先读代码** ——
> 不要假设它有常规开源项目的打磨程度。版本号 < 1.0，配置键不保证稳定。

---

## 1. 功能与配置

### 它做什么

| 围栏 | 切换 | 渲染结果是怎么来的 |
|---|---|---|
| `html` `svg` | 预览 / 代码 | 沙箱 iframe 真实渲染，默认禁脚本 |
| `csv` `tsv` | 表格 / 代码 | 自己实现 RFC 4180 解析，DOM 建表（不解析标记） |
| `json` | 表格 / 代码 | 只认**对象数组**；对象不是表 |
| `markdown` | 表格 / 代码 | 只认**整个围栏就是一张管道表**，否则原样 |
| `echarts` `chart` | 图表 / 代码 | 模型只写 option 的 JSON，引擎按需加载 |
| 其它（`py` …） | — | **完全不碰**，DSH 什么样就什么样 |

**只作用于「会话」标签页。** 轨迹标签页也渲染 `.md-code-block`，但它的 DOM 不带任何
`data-chat-*` 属性而会话区带 —— 边界建在这个实测差异上，不需要知道 shell 如何组织标签页。

> **`echarts` 围栏不需要写 HTML。** 只写 ECharts 的 option JSON 就够了，不用引 CDN、
> 不用 `<script>`、也不需要打开 `htmlAllowScripts` —— 引擎是插件自己按需加载的代码。

### 配置

所有可调项都是**插件配置**，写在 Loader 行的 `config` 里。改**当前 profile** 的行为：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: dsh-viewer-kit
  config:
    htmlAllowScripts: true
```

用户 patch 在所有组合包层**之后**应用、按行 id 胜出，所以这样写会覆盖包内默认值。
改完刷新即可，不必重启。

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 后所有渲染器都不认领，代码块保持 DSH 原样 |
| `defaultToPreview` | `true` | 认领到的块默认打开**渲染结果**而不是源码 |
| `previewHeightMode` | `measure` | HTML 预览高度怎么定 —— 见下 |
| `maxPreviewHeight` | `320` | `measure`/`fit` 下是**上限**，`fixed` 下就是**框高** |
| `chartHeight` | `360` | 图表高度。图表**必须**有确定高度，否则画布渲染成 0 高 |
| `htmlAllowScripts` | `false` | 允许预览里的 HTML 执行**它自己的**脚本 |
| `maxSourceBytes` | `262144` | 超过这个大小的源码保持原生代码块 |
| `disabledRendererIds` | `[]` | 按 id 关掉个别渲染器，无需卸载 |

### 预览高度是怎么定的

| 模式 | 短内容 | 长内容 | 代价 |
|---|---|---|---|
| `measure`（默认） | 框**贴合内容**，无留白 | 顶到上限后框内滚动 | frame 需要 `allow-scripts` 跑测量脚本 |
| `fit` | 估算贴合，可能略差 | 同上 | 估算偏小时会出现滚动条 |
| `fixed` | 完整显示，**下方留白到固定高度** | 超过即滚动 | 完全可预期，但短内容必然有留白 |

**为什么默认是 `measure`：** DSH 自己的代码视图**也没有固定高度** —— `<pre>` 只设了
`padding` 与 `overflow-x:auto`，高度由内容决定（证据：`._block_7gxqk_4 :where(pre)`，
见 `src/client/dom-contract.js`）。固定预览高度会让两个互相切换的视图行为不一致。
测量让预览和它旁边的代码视图保持同一种语义：内容多高就多高。

**为什么需要脚本：** `<iframe>` 是替换元素，它的高度**永不来自内部文档** ——
`max-height` 只能限制默认的 150px，CSS 里没有任何写法能表达"短内容全显、长内容滚动"。
所以高度只能被测出来。取舍是把测量脚本放进文档里量自己，而不是去跨 browsing context 读
—— 后者在规范上不可能成立（sandbox 标志会被嵌套 frame 继承并取并集）。

### 关于 `htmlAllowScripts`

默认关闭，所以预览里**带 `<script>` 的 HTML 不会执行**。这和 echarts 图表无关 ——
图表走 ` ```echarts ` 围栏，引擎是插件按需加载的可信代码。

打开后 frame 仍是**不透明源**，读不到宿主的 DOM / cookie / storage。变化的是：
**仅仅渲染一段内容就可能发起该内容里的网络请求**（远程图片自动加载、脚本可向任意地址发请求）。
内容本身是模型写的，泄露面基本限于模型已写出的东西 —— 但"看一眼就联网"确实是新引入的能力。

> DSH 有配置界面（`dsh-settings` + `dsh-config-editor`），但按其 README：表单只暴露标了
> `.volatile()` 的字段，且**目前没有任何客户端实现按 schema 自动生成表单**。
> 所以现阶段开关是上面这段 patch 文本，不是界面里的一个勾。

### 已知限制

1. **强耦合 DSH 的内部 DOM。** 插件不注册 Slot、不重写组件，而是在 DSH 的
   `[data-code-block-content]` 旁边挂自己的节点 —— 那节点是官方 CSS 注释标注的
   "stable content node"，但它依然是**内部实现**。核对版本：**DSH Desktop `0.2.0-rc.2`**。
   DSH 升级后形状一旦改变，插件会**静默不生效**（不是崩溃）。核对入口只有一个文件：
   `src/client/dom-contract.js`，升级步骤见 §4。

2. **围栏语言名可能是空的。** DSH 的语言表是 **Shiki 内置的，不支持自定义**，
   banner 只在有高亮器时才写语言名。所以 ` ```echarts ` 拿到的标签是通用文案，
   **原始语言名在 DOM 里不存在**。插件的应对是**按内容判定**（能解析成含 `series`
   的非数组对象就是图表）。内容启发式**可能判错** —— 判错时表现为某个块多了个切换按钮，
   不会有更糟的后果，但它确实是一条启发式。

3. **`measure` 模式给预览 frame 开了 `allow-scripts`**（为了跑测量脚本）。模型自己的脚本由
   **CSP nonce 策略**拒绝，frame 保持不透明源，两道防线独立生效。介意的人可以设
   `previewHeightMode: fit` —— 那是**零脚本权限**的，代价是高度靠估算。

4. **只覆盖会话标签页的 `.md-code-block`。** 工具卡片、附件、其它面板里的内容不在范围内。

---

## 2. 安装

**本项目不发布到 npm**，从本地目录或打包好的 tarball 安装。

```powershell
# A. 从本地目录（开发时最常用）
dsh plugin --profile desktop add file:E:\path\to\dsh-viewer-kit

# B. 从 tarball（适合分发给别人 / 内网）
npm pack                                        # prepack 已配好，会自动构建
dsh plugin --profile desktop add ./dsh-viewer-kit-0.9.0.tgz
```

装完**刷新页面**（`Ctrl+Shift+R`）即可，宿主会热加载，不用重启 DSH。

> **不要走 `github:` 直装。** 官方《[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)》
> 明确警告：git 安装拉的是**源码不是产物**，pnpm ≥10 会拒绝运行它的 `prepare` 脚本，
> 除非用户在 profile 的 `pnpm-workspace.yaml` 里写 `allowBuilds` —— 那等于**允许该包的代码
> 在安装时于本机执行、且不在任何沙箱内**。分发预构建产物就没有这道坎。

### 确认它活着

控制台应该出现三行：

```
[dsh-viewer-kit] config: default view=preview, html scripts=off, max preview height=320px, chart height=360px
[dsh-viewer-kit] renderers: html, echarts, table
[dsh-viewer-kit] v0.9.0 active — N code block(s) enhanced
```

> 渲染器按**优先级**排列而非注册顺序：`html` 10 > `echarts` 8 > `table` 5。

排「装了但没渲染」用这一条命令：

```js
__DSH_VIEWER_KIT__.diagnose()
```

| 现象 | 含义 |
|---|---|
| `__DSH_VIEWER_KIT__` 是 `undefined` | 客户端半体没加载 → 硬刷新 |
| `blocks: 0` | 插件活着，但页面上没有 `.md-code-block` → 那段内容不是围栏代码块 |
| `unclaimed` 里有你的语言 | 找到了但没被认领 → 看 `languages` 里实际读到什么 |
| `outsideConversation > 0` | 那些块在其它标签页，**故意不碰**，不是漏认 |
| `enhanced > 0` | 在工作，去看代码块头部有没有切换按钮 |

### 一条禁令

**不要手改 profile 的 `cordis.patch.yml` 去插插件行。** 那一行是 Loader 的**生成物**；
下一次任何 `dsh plugin add` 都会重写整个文件，那行就没了，插件静默消失。
走 `dsh plugin add`，它会进 profile 的 `dependencies` 与 `dsh.profile.bundles`，
之后不再被冲掉。（这一点本项目真的踩过，复盘见架构文档 §13.4。）

---

## 3. 开发

构建走 **tsdown** —— 与官方 `dsh-experimental-client-ui-voice-input` 和社区 `dshmarket`
同一条管线，产物是 DSH 客户端模块系统要求的
`window.__ModuleLoader__.load({ id, factory })` 经典脚本格式。

```powershell
pnpm install
pnpm run check        # 类型检查 → 构建 → 93 项测试 → 产物激活复现
pnpm run release      # check + 打包自检，完整发布门禁
```

需要 **Node ≥ 22**（tsdown 用到 `Promise.withResolvers`）。仓库用 `.node-version` 声明 `24`，
`package.json` 的 `engines.node` 兜底。**用版本管理器显式选定**，因为 `pnpm run` 是用
PATH 上的 `node` 拉起子进程的，PATH 上是旧版会直接失败：

```powershell
fnm use                                   # 交互式：靠 .node-version 自动切
fnm exec --using=24 -- pnpm run check     # 脚本/CI：不依赖 shell 配置
```

### 开发循环

```
pnpm run build  →  重新安装  →  刷新页面
```

pnpm 把 `file:` 目录依赖**拷贝**进 profile 的 `node_modules`（不是硬链接），所以光构建不重装，
profile 里那份会停在安装那一刻的内容，**而且任何地方都不报错**。`install_bundle` 在 lockfile
未变时会回 `Already up to date` 拒绝重装，需要先移除再安装。

### 发布前自检

```powershell
pnpm run preflight   # 打包 → 解包到临时目录 → 校验 → 清理
```

校验的是**用户真正拿到的那份字节**，而不是工作树：manifest 的声明、`exports["./client"]`
能否解析（解析不到就是 `MissingClientBundleError`，而渲染进程的 boot 审计会把 entry 失败
判成**启动失败**）、host 半体能否 import、按需加载的引擎 chunk 是否在包里并与入口请求的
文件名一致，最后让解出来的客户端 bundle 在严格 `ctx` 下真实激活一次。

> 这个自检做过**负向测试**：把 `client/client.js` 改名、把 patch 行写成别的包名、
> 删掉 `dsh.bundle` 声明、去掉引擎 chunk —— 四种破坏都被精确报出。
> 一个不会失败的检查比没有检查更坏。

---

## 4. 其他

### 它是怎么工作的

DSH 的 markdown 渲染器是封闭的，没有留给插件的节点扩展点（证据见 `docs/01-architecture.md` §2.3）。
所以本插件**不注册任何 Slot、不重写任何组件**，只在 DSH 自己标注为"给消费者用"的节点上挂东西：

```html
<div class="… md-code-block">
  <div data-code-block-banner>          ← 官方注释：stable content node
    …语言名…  …换行/复制…                      切换控件追加到这里
  </div>
  <div data-code-block-content>         ← 官方注释：stable content node
    <div class="shiki"><pre>…</pre></div>      原生代码，保持原样
    <div data-dvk-root>                        我们追加的渲染结果
  </div>
</div>
```

切换视图**只改一个我们自己的属性**（`data-dvk-mode`），由插件自己的样式表决定谁可见。
原生 `<pre>` 一个字节都没动过，所以切回代码零失真。

由此得到的硬性质：

| 性质 | 怎么做到的 |
|---|---|
| 零破坏性 | 不注册 Slot、不 shadow 任何已注册的 key |
| 卸载即复原 | 清理挂在 `ctx.effect` 的 disposer 上；`dispose()` 只删自己加的节点 |
| 不打断流式 | 内容节点的子元素形态本身就是"稳定了没"的信号；流式中的 JSON 解析不过，自然不会误认领 |
| 换接缝不动渲染器 | 接缝只产出 `RenderRequest`，Kit 与渲染器不知道 DOM 存在 |

架构与取舍的完整记录在 [`docs/01-architecture.md`](docs/01-architecture.md)；
新增一个渲染器见 [`docs/02-renderer-authoring.md`](docs/02-renderer-authoring.md)。

### 目录

```
src/client/
  index.js             入口：apply(ctx, config)，装 Kit → 注册渲染器 → 装样式 → 起接缝
  contract.js          共享词汇：RenderRequest / Renderer / 指纹 / 语言归一化
  kit.js               注册表 · 协商 · 视图状态 · 配置 · 统计（零 DOM）
  view-state.js        按内容指纹记忆视图选择（sessionStorage，可降级）
  dom-contract.js      ★ 唯一记录 DSH DOM 契约的地方（升级时只核对这里）
  dom-seam.js          L1 发现 / 回收 / 作用域边界 / 流式守卫
  code-block-surface.js L3 一个 surface = 一个代码块
  chunk-loader.js      按需加载引擎 chunk（走 DSH 原生 chunk 机制）
  chunks/echarts.js    引擎本体，独立成文件，不进入口 bundle
  renderers/           L5 渲染器：echarts / html / table
src/index.js           Host 半体（仅作为 Loader 行的锚点）
client/                ★ 构建产物，提交进库（见下）
tests/                 93 项测试 + DOM 垫片 + 从 DSH 真实产物抄来的夹具
tools/                 asar 读取脚本 + 发布前自检
docs/                  架构设计 / 渲染器作者指南
tsdown.config.ts       ★ 客户端 bundle 的构建契约（模块格式与 chunk 规则在这里定义）
```

`package.json` 的 `files` 只发布 `lib/ client/ src/ docs/ cordis.patch.yml LICENSE README.md`
—— 装进 profile 的只需要这些；`tests/ scripts/ tools/` 与 `tsdown.config.ts` 是仓库内的工作流。

> **构建产物是提交进版本库的**，这与"不提交产物"的常规做法相反，是有意的：本仓库就是被
> `pnpm add file:<path>` 安装的那一份，而 DSH 激活时会直接 `readFileSync` 这个 bundle，
> 缺文件会抛 `MissingClientBundleError` 并让 entry 激活失败。提交它们，新克隆的树才开箱可装
> —— **这一条实测过：`git clone` 后不装任何依赖，93 项测试全绿。**
> 改完源码务必重新 `pnpm run build` 再提交。

### 升级 DSH 之后

（在**本仓库**里做，不需要动装进 profile 的那份。）

1. 用 `tools/asar-extract.ps1` 把新的 `CodeBlock` / `CodeCard.module.css` 与 shell 样式表抽出来
   （`tools/README.md` 记了 asar 头部格式的坑）；
2. 核对 `src/client/dom-contract.js` 里引用的 DOM 形状与行号 —— 只有这一个文件需要改；
3. `pnpm run check`：类型检查、产物构建、夹具与断言会告诉你变了什么；
4. 重新安装（见 §2），让宿主拿到新的 `client/client.js`。

### 安全

模型产出的 HTML 属于**不可信输入**。预览一律走 `<iframe sandbox>`：

- **任何配置下都不会同时给 `allow-scripts` 和 `allow-same-origin`**（那才是真正的逃逸）；
- `measure` 模式的 frame 带 `allow-scripts`（跑测量脚本），模型脚本由 **CSP nonce 策略**
  拒绝；`fit` / `fixed` 模式下 frame 是 `sandbox=""`，**零脚本权限**；
- `referrerpolicy="no-referrer"`；
- 表格视图用 DOM API 建节点，**不解析模型产出的标记**；
- 不提供"在新标签页打开"—— 那会用 `blob:` URL 以宿主同源执行，恰好绕开全部沙箱保证。

已知的残留风险：渲染一段 HTML **可以发起该内容里的网络请求**（远程图片、CSS），
这一条在**所有**配置下都成立，因为浏览器必须加载子资源才能排版。

### 许可

MIT
