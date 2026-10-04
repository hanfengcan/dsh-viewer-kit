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
| `html` `svg` | 预览 / 代码 | 沙箱 iframe 真实渲染，默认禁脚本；可**放大**成弹窗看全文 |
| `csv` `tsv` | 表格 / 代码 | 自己实现 RFC 4180 解析，DOM 建表（不解析标记）；表头吸顶 |
| `json` | 表格 / 代码 | 只认**对象数组**；对象不是表 |
| `markdown` | 表格 / 代码 | 只认**整个围栏就是一张管道表**，否则原样 |
| `echarts` `chart` | 图表 / 代码 | 模型只写 option 的 JSON，引擎按需加载 |
| 其它（`py` …） | — | **完全不碰**，DSH 什么样就什么样 |

**只作用于「会话」标签页。** 轨迹标签页也渲染 `.md-code-block`，但它的 DOM 不带任何
`data-chat-*` 属性而会话区带 —— 边界建在这个实测差异上，不需要知道 shell 如何组织标签页。

### 高度与「看全内容」

三个渲染器里**只有两个物理上必须封顶**，因为它们的内容高度无法从 DOM 推出：

| 渲染器 | 封顶 | 为什么必须 |
|---|---|---|
| `html` | `maxPreviewHeight` 320 | `<iframe>` 是替换元素，高度**永不来自内部文档**；`max-height` 只能限制默认的 150px。只能测出来再封顶 |
| `echarts` | `chartHeight` 360 | canvas 在 auto 高度盒子里渲染成 **0** 高 |
| `table` | `maxTableHeight` 480 | **不是必须** —— 表格能自然撑开。封顶是为了不把对话拉长 |

**放大控件不是全局的 —— 只有提供 `expand` 的渲染器才有按钮，没提供的连控件都不长。**
目前是 **html 预览**和**表格**两个，行为由渲染器自己决定：

- **表格**：就地取消高度封顶，整张表在对话里展开。再点一次恢复。
- **HTML 预览**：开一个 **`<dialog>` 弹窗**，高度按视口的 86% 算，内容按真实高度撑开。
  短文档无滚动条、无留白；长文档只在物理上装不下时才出现滚动条。

**图表没有放大控件。** 图表有确定的 `chartHeight`，不存在"内容比框高"那种失控 ——
封顶和逃生口这一对只在高度会失控的渲染器上才成立。要给图表加也可行（ECharts 有
`resize()`，ResizeObserver 已经在看着了），但那是另一件事。

弹窗**不是**手写的 `position: fixed` 蒙层，而是 `showModal()` —— 浏览器把它提到
**top layer**，这是唯一能绕开包含块的办法（`fixed` 元素是相对**最近创建包含块的祖先**
定位的，而本插件自己的 `.dvk-chart { contain: content }` 就已经是一个包含块）。
顺带白拿背景遮罩、ESC 关闭和焦点陷阱。弹窗挂在 `document.body` 上而不是块里 ——
会话是虚拟化的，块可能在弹窗还开着的时候被回收。

> **封顶和放大必须成对。** 只封顶不给出路，等于拿掉"一眼看全 500 行"的能力 ——
> 而那恰恰是没有封顶时唯一能看到全部的方式。

> **`echarts` 围栏不需要写 HTML。** 只写 ECharts 的 option JSON 就够了，不用引 CDN、
> 不用 `<script>`、也不需要打开 `htmlAllowScripts` —— 引擎是插件自己按需加载的代码。

### 实际效果

以下截图取自 DSH Desktop `0.2.0-rc.2` 真实运行，未做修饰。

**`html`** —— 沙箱 iframe 渲染，高度贴合内容：

![HTML 预览：沙箱渲染，高度贴合内容](docs/imgs/html.png)

**`echarts`** —— 模型只写 option 的 JSON，引擎作为独立文件按需加载：

![ECharts 图表：柱状 + 折线双系列](docs/imgs/echarts.png)

**`csv`** —— 自实现 RFC 4180：引号内的逗号与转义引号不会被拆成两格：

![CSV：引号内逗号与转义引号](docs/imgs/csv.png)

**`json`** —— 只认对象数组：

![JSON 对象数组渲染为表格](docs/imgs/json.png)

**`markdown`** —— 管道表格，**不需要标注语言**：

![Markdown 管道表格](docs/imgs/markdown.png)

### 配置

所有可调项都是**插件配置**，写在 Loader 行的 `config` 里。改**当前 profile** 的行为：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: dsh-viewer-kit
  config:
    htmlAllowScripts: true
```

用户 patch 在所有组合包层**之后**应用、按行 id 胜出，所以这样写会覆盖包内默认值。

> **改完要重启 profile，不只是刷新页面。** 配置由**宿主半体**在激活时读取并校验，
> 浏览器是启动后去取它的结果。刷新页面只会让客户端重新拉一次**同样的**结果。
> 启动日志里那一行 `host config published at /dsh-viewer-kit/config: {...}` 就是宿主读到的值。

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 后所有渲染器都不认领，代码块保持 DSH 原样 |
| `defaultToPreview` | `true` | 认领到的块默认打开**渲染结果**而不是源码 |
| `previewHeightMode` | `measure` | HTML 预览高度怎么定 —— 见下 |
| `maxPreviewHeight` | `320` | `measure`/`fit` 下是**上限**，`fixed` 下就是**框高** |
| `maxTableHeight` | `480` | 表格超过这个高度就开始**框内滚动**，表头吸顶 |
| `chartHeight` | `360` | 图表高度。必须 > 0，否则画布渲染成 0 高 |
| `htmlAllowScripts` | `false` | 允许预览里的 HTML 执行**它自己的**脚本 |
| `maxSourceBytes` | `262144` | 超过这个大小的源码保持原生代码块 |
| `disabledRendererIds` | `[]` | 关掉个别渲染器，**两层语义** —— 见下 |

#### 配置怎么从磁盘走到浏览器

这一段是本插件最反直觉的地方，值得单独说，因为**改错地方不会有任何提示**。

```
cordis.patch.yml  ──▶  宿主半体 apply(ctx, config)  ──▶  Config schema 校验
                                                              │
                                                     失败：响亮报错（安全，宿主无行为）
                                                              │
                                                     通过：GET /dsh-viewer-kit/config
                                                              │
                                            浏览器 apply() ────┘  首扫之前 fetch 一次
```

**为什么需要这一跳。** 渲染发生在浏览器里，而配置在 Node 进程的 patch 文件里。中间的
boot 线缆**不带配置** —— `graphRow()` 只发 `{id, url, rev, inject?, immediately?, external?}`，
`parseBootManifest()` 只读回这几个字段，所以客户端 `apply(ctx, rowConfig)` 拿到的
`rowConfig` **恒为 `undefined`**。这不是本插件的缺陷，是 DSH 目前的形状。
社区插件 `dshmarket` 走的是同一条路（宿主 `apply(ctx, config)` + `webServer.register`，
客户端 `fetch`）。

**两个半体的严格程度故意不同：**

| | 宿主半体 | 客户端半体 |
|---|---|---|
| 遇到错值 | **响亮失败**（`Config` schema） | 静默回落默认值 |
| 遇到不认识的键 | **报错** | 忽略 |
| 为什么 | 配置写错本来就该立刻发现；且宿主半体无行为，失败只记日志，**不会炸 web boot** | 路由 404、宿主半体没装、两个版本不一致 —— 这些情况下**能渲染**比"报错什么都看不到"重要得多 |

**改完仍不生效，按这个顺序查：**

1. 浏览器控制台那行括号里是 `from host` 还是 `from defaults`
2. 宿主进程日志有没有 `host config published at …`
3. `pnpm run probe` —— 它盯着 DSH 的宿主源码，线缆形状变了会报红

`tools/probe-host.mjs` 有一条**故意埋的绊子**：`the boot wire still carries no config,
so P0 is still open`。DSH 哪天给线缆加了配置，这条会红 —— 那天就可以删掉整条 HTTP 桥，
直接读行配置。

#### `disabledRendererIds` 的两层语义

同一个列表，两层，区别是整件事容易搞错的原因：

| 写法 | 含义 | 块会怎样 |
|---|---|---|
| `['table']` | 按**渲染器 id** 关闭 | 该渲染器不再认领，块**重新交给剩下的渲染器**；没人认领就回落原生代码视图 |
| `['csv']` | 按**围栏名**关闭 | 该块**根本不进渲染器**，不管有没有渲染器认领它 |

两者会重叠：`['csv']` 和 `['table']` 都能关掉 CSV 表格，但原因不同。真正分家的是
**没有同名渲染器的语言** —— `['json']` 会让所有 `json` 块原样保留，而这是"别让 ECharts
option 被表格渲染器认领"却不点名 `echarts` 的唯一办法。

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

> **DSH 没有「按 schema 自动生成表单」这回事。** 核过 shipped 产物
> `@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js`：它只是
> `settings.plugins.tab` 这个 slot 的**容器**，自带的那一页是**只读清单**
> （文案就是 "Inspect the plugins this deployment ships."），官方注释明说
> 「配置页在各自的 companion package 里」。没有 Form generator。
>
> 所以本插件导出 `Config` schema 得到的是**校验 + 默认值 + agent 可读的 JSON Schema**
> （`cordis_inspect_query` → `Config.listConfigs` 能查到），**不是**一个能点的界面。
> 要界面得自己注册一个 tab 页面并提供读写路由，那是另一件事。

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

浏览器控制台出现四行（宿主进程另有一行 `host config published at …`）：

```
[dsh-viewer-kit] renderers: html, echarts, table
[dsh-viewer-kit] waiting for the host config route
[dsh-viewer-kit] config: default view=preview, html scripts=off, max preview height=320px, chart height=360px (from defaults, host answered 404)
[dsh-viewer-kit] v0.9.0 active — N code block(s) enhanced
```

> 渲染器按**优先级**排列而非注册顺序：`html` 10 > `echarts` 8 > `table` 5。
> 括号里是配置的来源。`from host` 说明宿主半体在跑、`cordis.patch.yml` 里的值已生效；
> `from defaults, …` 说明没读到宿主配置，**所有键都是默认值** —— 想知道原因，括号里写了。

排障时用这一条命令：

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

> profile 的 `cordis.patch.yml` 有两种条目，**别混为一谈**：
>
> - **`config:` 覆盖** —— 这就是那个文件的主要用途，按 §1 放心写，改完刷新即生效；
> - **`insert:` 行** —— 本插件那一行在**包自己的** `cordis.patch.yml` 里，
>   由 `dsh.profile.bundles` 选中后生效。**不要在 profile 里再手写一遍**：
>   那是重复的生成物，下次任何 `dsh plugin add` 都会重写整个文件，手写的那行会被冲掉。

---

## 3. 开发

构建走 **tsdown** —— 与官方 `dsh-experimental-client-ui-voice-input` 和社区 `dshmarket`
同一条管线，产物是 DSH 客户端模块系统要求的
`window.__ModuleLoader__.load({ id, factory })` 经典脚本格式。

```powershell
pnpm install
pnpm run check        # 类型检查 → 构建 → 122 项测试 → 产物激活复现 → 宿主契约探针
pnpm run release      # check + 打包自检，完整发布门禁
```

`check` 的最后两步是**对着本机装的 DSH 查契约**。按需加载引擎 chunk 依赖三条没有公开文档的
事实（chunk 文件名规则、`require.async`、缺失 bundle 的具名错误），它们一旦被 DSH 升级改掉，
失败方式不是报错，而是图表静默不画。所以 `tools/probe-host.mjs` 直接读安装目录里的
`app.asar`，把 `@deepseek-ai/dsh-client-modules` 的真实产物当事实来源；探针本身有
`tests/probe-host.mjs` 九条负向测试，每条检查都有一个"改坏"的宿主能让它变红 —— 不然它就只是
一串永远为真的输出。探针找不到 DSH 时 SKIP 而非通过。

需要 **Node ≥ 22**（tsdown 用到 `Promise.withResolvers`）。仓库用 `.node-version` 声明 `24`，
`package.json` 的 `engines.node` 兜底。**用版本管理器显式选定**，因为 `pnpm run` 是用
PATH 上的 `node` 拉起子进程的，PATH 上是旧版会直接失败：

```powershell
fnm use                                   # 交互式：靠 .node-version 自动切
fnm exec --using=24 -- pnpm run check     # 脚本/CI：不依赖 shell 配置
```

### 开发循环

```
pnpm run build  →  覆盖 profile 里那份  →  刷新页面
```

pnpm 把 `file:` 目录依赖**拷贝**进 profile 的 `node_modules`（不是硬链接），所以光构建不覆盖，
profile 里那份会停在安装那一刻的内容，**而且任何地方都不报错**。

**但"覆盖"不等于"重装"。** 用拷贝覆盖那几份产物就行，**不要走 `remove_bundle` + `install_bundle`**：

```powershell
$inst = "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-viewer-kit"
Copy-Item client\client.js        "$inst\client\client.js" -Force
Copy-Item lib\index.js  "$inst\lib\index.js"  -Force
Copy-Item lib\schema.js "$inst\lib\schema.js" -Force
```

**为什么。** `@deepseek-ai/dsh-client-hmr` 每 **500ms**（`pollIntervalMs`）比对已安装 bundle 的
`mtime / ctime / size`，一变就 `clientModules.rebuilt(id)` → 重组 boot 图 → SSE 推给浏览器。
所以覆盖文件后**半秒内 DSH 自己就热换了**。而 `remove_bundle` 那条路会带来两个已知故障：

| 现象 | 原因 |
|---|---|
| 顺带把 `dsh-schedule-later` 禁用了 | `remove_bundle` 的 bug，可复现 |
| 重新启用时 `webserver: duplicate exact route` | 旧路由还没从表里摘掉，要重启 DSH |
| `import failed (see console…)` | 边跑边装，图重组会让在途 import 失效 |

**这三样都是重装流程本身造成的，与插件无关。** 拷贝覆盖一条都不碰。

> **但宿主半体（`lib/*.js`）不参与热换。** 客户端 bundle 有人盯，宿主模块已经被 ESM loader
> 缓存进正在跑的进程，fiber 重启也只是重跑**旧**的 `apply`。所以改了 `lib/` 之后，
> `Config` schema 和配置路由要**重启 DSH** 才生效。判断方法：
> `cordis_inspect_query(Config.listConfigs, {name:"dsh-viewer-kit"})` 的 `status` 从
> `absent` 变成有 schema，就说明宿主半体已经是新的了。

`install_bundle` 在 lockfile 未变时会回 `Already up to date` 拒绝重装 —— 那是给"真要重装"用的，
不在上面这条循环里。

### 发布前自检

```powershell
pnpm run preflight   # 打包 → 解包到临时目录 → 校验 → 清理
```

校验的是**用户真正拿到的那份字节**，而不是工作树：manifest 的声明、`exports["./client"]`
能否解析（解析不到就是 `MissingClientBundleError`，而渲染进程的 boot 审计会把 entry 失败
判成**启动失败**）、host 半体能否 import、按需加载的引擎 chunk 是否在包里并与入口请求的
文件名一致，最后让解出来的客户端 bundle 在严格 `ctx` 下真实激活一次。

> 这个自检做过**负向测试** —— 改坏产物名、写错 patch 里的包名、删掉声明、去掉 chunk，
> 四种破坏都能被报出。一个不会失败的检查比没有检查更坏。

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
tests/                 122 项测试 + 探针负向测试 + DOM 垫片 + 从 DSH 真实产物抄来的夹具
tools/                 宿主契约探针（读 app.asar）+ 发布前自检
docs/                  架构设计 / 渲染器作者指南
tsdown.config.ts       ★ 客户端 bundle 的构建契约（模块格式与 chunk 规则在这里定义）
```

`tests/ scripts/ tools/` 与 `tsdown.config.ts` 是仓库内的工作流，与安装无关，任何情况下都不进包。

> **构建产物是提交进版本库的**，这与"不提交产物"的常规做法相反，是有意的：本仓库就是被
> `pnpm add file:<path>` 安装的那一份，而 DSH 激活时会直接 `readFileSync` 这个 bundle，
> 缺文件会抛 `MissingClientBundleError` 并让 entry 激活失败。提交它们，新克隆的树才开箱可装
> —— **这一条实测过：`git clone` 后不装任何依赖，122 项测试全绿。**
> 改完源码务必重新 `pnpm run build` 再提交。

> **tarball 只装必需的东西。** `package.json` 的 `files` 只有 `lib/ client/
> cordis.patch.yml LICENSE README.md` —— 那前两项加 patch 文件，就是宿主在安装与激活时
> 真正会解析到的全部路径（`main`、`exports["./client"]`、`dsh.bundle.patch`，
> 以及被入口 `require.async` 请求的引擎 chunk）。`src/` 与 `docs/` **不进包**：
> 产物已预构建、文档在 GitHub 上，装进 profile 用不到它们，各省约 110 KB 与 160 KB。

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
