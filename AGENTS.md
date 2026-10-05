# AGENTS.md

给**在这个仓库里改代码**的 AI agent（以及人类贡献者）。

**README.md 是给使用者的**：它能做什么、怎么装、有哪些配置键、有什么限制。
**这份文件是给改动者的**：命令、不变量、单一真相来源、以及这个仓库的房子规矩。
写进 README 的东西要经得起"一个只想用插件的人会不会需要知道"这一问；不需要的写这里。

---

## 1. 这个项目是什么

`dsh-viewer-kit` 是 DSH 的一个插件，给会话里的代码块加上"渲染结果"视图（预览 / 表格 / 图表），
与原生源码一键切换。

**它可以拆成两个半体，这是理解一切的前提：**

| | 跑在哪 | 入口 | 能不能热换 |
|---|---|---|---|
| Host 半体 | Node 进程 | `src/index.js` → `lib/index.js`（原样拷贝） | ❌ 要重启 DSH |
| Client 半体 | 浏览器 | `src/client/index.js` → `client/client.js`（tsdown 打包） | ✅ 约 500ms |

两者唯一的通道是一条 HTTP 路由 `GET /dsh-viewer-kit/config`：**boot 线缆不携带配置**
（`graphRow()` 只发 `{id,url,rev,inject?,immediately?,external?}`，`parseBootManifest()`
只读回这几个字段），所以浏览器里的 `apply(ctx, rowConfig)` 拿到的 `rowConfig` 恒为 `undefined`。

> **当前状态：这是对 DSH 一处空白的绕行，不是它设计的通道。**
> `tools/probe-host.mjs` 里有一条**故意埋的绊子**（`the boot wire still carries no config`）：
> DSH 哪天给线缆加了配置，它就会变红 —— 那天应该删掉整条 HTTP 桥。

---

## 2. 命令

```powershell
pnpm install
pnpm run build       # tsdown 打客户端 + 拷贝宿主半体到 lib/
pnpm run typecheck   # tsc --noEmit（含 checkJs）
pnpm test            # 159 项测试
pnpm run repro       # 单独跑一次激活复现，带栈
pnpm run check       # typecheck → build → test → repro → probe:test → probe
pnpm run preflight   # 打包 → 解包 → 校验 → 清理
pnpm run release     # check + preflight
pnpm run probe       # 拿本机 DSH 的 app.asar 核对宿主契约
```

**Node 必须是 ≥ 22**，而且**要显式选定**：`pnpm run` 用 PATH 上的 `node` 拉起子进程，
PATH 上是旧版会直接失败（`Promise.withResolvers is not a function`，出错信息指向 tsdown，
不指向 node）：

```powershell
fnm exec --using=24 -- pnpm run check
```

> 这台机器上 PATH 默认是 nvm4w 的 **v20.19.5**，比 workspace 自带的 v24 还旧。
> 遇到那个报错先查 `node -v`，不要查 tsdown。

---

## 3. 开发循环：拷贝覆盖，**不要重装**

```powershell
$inst = "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-viewer-kit"
Copy-Item client\client.js "$inst\client\client.js" -Force
Copy-Item lib\*.js         "$inst\lib\"             -Force
```

`pnpm add file:` 把依赖**拷贝**进 profile 的 `node_modules`（不是硬链接），所以光 `build`
不会生效，profile 里那份停在安装那一刻，**而且任何地方都不报错**。

**但不要为此走 `remove_bundle` + `install_bundle`。** 那条路必定带来三个故障，
且**全部是流程本身造成的，与插件无关**：

| 现象 | 原因 |
|---|---|
| 顺带把 `dsh-schedule-later` 禁用了 | `remove_bundle` 的 bug，可复现 |
| 重新启用时撞 `webserver: duplicate exact route` | 旧路由还没从表里摘掉，要重启 DSH |
| `import failed (see console…)` | 边跑边装，图重组会让在途 import 失效 |

**拷贝覆盖一条都不碰**，因为 `@deepseek-ai/dsh-client-hmr` 每 500ms（`pollIntervalMs`）
比对已安装 bundle 的 `mtime / ctime / size`，一变就 `clientModules.rebuilt(id)` →
重组 boot 图 → SSE 推给浏览器。

> **`Copy-Item` 会保留源文件的 mtime。** 如果源比目标旧，HMR 可能看不出变化。
> 拿不准就补一句 `(Get-Item $dst).LastWriteTime = Get-Date`。

### 宿主半体要重启，这是设计不是疏漏

`dsh-hmr` 的默认忽略清单里有 **`**/node_modules`**（`dsh-hmr/lib/index.js:241`，
经 `picomatch` 应用在 watcher 的 `ignored` 上）。`file:` 安装的插件正好住在 profile 的
`node_modules` 里，所以它的**宿主模块永远不会被监听**。

fiber 重启也救不了：模块已被 ESM loader 缓存进正在跑的进程，重启 fiber 只是重跑**旧**的 `apply`。

**判断宿主换没换**：`cordis_inspect_query(Config.listConfigs, {name:"dsh-viewer-kit"})`
的 `status` 从 `absent` 变成有 schema，就是新的了。

---

## 4. 房子规矩

### 4.1 注释只写不变式，不把聊天记录和一次性的坑写进去 —— **这是硬要求**

代码注释是给**六个月后不知道这段对话存在的人**看的。

**判据：如果产生这段代码的那次对话从未发生，这句话还成立、还有用吗？**
只在那次对话的语境里才读得懂的，删掉。

**写这些：**

- 为什么是这个形状（约束、不变量、被排除的方案）
- 改掉会怎样坏（失败模式）
- 反直觉之处的解释（"看起来多余，其实是因为…"）

**不写这些：**

- 谁报告的、在哪次对话里、什么时候
- "the bug this fixes"、"reported from the real app"、"用户反馈"、"上次踩的坑"
- 任务编号、提交哈希、评审意见
- 变更流水（那属于 git log）

**同一份文件里的真实对照**（左为实际写过的，右为应当写的）：

```js
/* ✗ 不好 —— 换个读者就是天书 */
// The bug this fixes, reported from the real app: pressing the button stuck it
// in its pressed style forever.
```

```js
/* ✓ 好 —— 机制与不变量，永远成立 */
// A modal dialog makes the page inert, so while it is open this button cannot be
// pressed again. Without a notification the state stays wrong after ESC.
```

```js
/* ✗ 不好 */
// hover 消失 —— which is exactly what happened while this button carried one
```

```js
/* ✓ 好 */
// A state rule and :hover have equal specificity, so source order decides.
```

**需要保留来龙去脉时**，不要塞进注释：写进 `docs/01-architecture.md`
（它按 § 分节，注释里引 `docs/01-architecture.md §4.6` 就够），注释只留引用。

> 这条规则由**测试守着**：`tests/run.mjs` 里有一条用例扫描 `src/`、`tools/`、`scripts/`，
> 命中 `the bug this fixes` / `reported from the real app` / `用户反馈` 之类字样即失败。
> 规则不可执行就会烂掉 —— 所以它可执行。
>
> 它**只认这些不会误判的说法**，刻意不去评判行文：一个试图评判散文的守卫，
> 不是太吵就是错判，两种结果都会训练人忽略它。`tests/` 不在扫描范围内 ——
> 那里"这个用例守着哪个回归"是正当的注释内容。

### 4.2 一个不会失败的检查，比没有检查更坏

这个仓库反复出现的原则。新加断言前先问：**要让它变红，得怎么做？**
做不到就是没有断言，而且更糟 —— 它给人"这里被覆盖了"的错觉。

已按此办理的例子：

- `tests/probe-host.mjs` —— 每条宿主检查都有一个"改坏"的宿主编档能让它变红，
  外加一条"忠实宿主必须全绿"（否则一个永远失败的探针也能满足全部负向测试）。
- `tools/preflight.mjs` —— 改坏产物名、写错包名、删声明、去掉 chunk，四种破坏都能报出。
- 文档守卫 —— README 引用的日志行、版本号、tarball 名、测试数、截图有无孤儿，全部对照真实产物。

### 4.3 单一真相来源

两处描述同一件事，就一定会有一处过期。已经合并过的：

| 事 | 唯一来源 |
|---|---|
| 配置键的默认值、严格校验、宽松回落、patch 文档 | `src/schema.js` 的字段表 |
| DSH DOM 契约（升级时**只**核对这里） | `src/client/dom-contract.js` |
| 客户端 bundle 的模块格式与 chunk 规则 | `tsdown.config.ts` |
| 客户端 / 宿主模块的加载与 on-demand chunk 契约 | `tools/probe-host.mjs`（读 app.asar） |

**判据见 §4.2**：如果两处可以不一致而不被发现，那就是一个还没建的单一真相来源。

---

## 5. 架构不变量（不许破坏）

1. **不注册任何 Slot、不重写任何组件、不 shadow 已注册的 key。** DSH 的 markdown 渲染器
   是封闭的，我们只在它自己标注为 stable content node 的节点上**追加**我们自己的节点。
2. **原生 `<pre>` 一个字节都不动。** 切回代码必须零失真。
3. **`dispose()` 只删自己加的节点**，并且要能在块被虚拟化回收时安全执行。
4. **Kit 层零 DOM。** `kit.js` / `contract.js` / `view-state.js` 不引用 `document`，
   所以协商逻辑可以在纯 Node 下测。
5. **客户端 `ctx` 只准读 `get` / `effect` / `on` / `provide`。** 读别的会抛
   （cordis 的 Context 是 proxy），而且抛在 `apply` 里等于 **web boot 失败**。
   `tests/ctx-harness.mjs` 有意比真宿主**更窄**，就是为了让这类错误在测试里炸而不是在产品里炸。
6. **预览永远是不透明源**：任何配置下都不同时给 `allow-scripts` 和 `allow-same-origin`。
7. **`client/` 是提交进库的产物。** 改完源码必须 `pnpm run build` 再提交。

---

## 6. 目录

```
src/index.js                 Host 半体：导出 Config、注册配置路由、装配工具
src/schema.js                ★ 配置的字段表（默认值 / 校验 / patch 文档的唯一来源）
src/client/
  index.js                   入口：apply(ctx, config)
  contract.js                共享词汇：RenderRequest / Renderer / 配置 typedef
  kit.js                     注册表 · 协商 · 视图状态 · 统计（零 DOM）
  dom-contract.js            ★ DSH DOM 契约，升级时只核对这里
  dom-seam.js                L1 发现 / 回收 / 作用域边界 / 流式守卫
  code-block-surface.js      L3 一个 surface = 一个代码块
  scroll-guard.js            认领块会改变它的高度；把由此产生的滚动位移抵消掉
  host-config.js             拉取宿主配置（带超时与回落）
  chunk-loader.js            按需加载引擎 chunk（走 DSH 原生 chunk 机制）
  chunks/echarts.js          引擎本体，独立成文件，不进入口 bundle
  renderers/                 L5 渲染器：echarts / html / table
src/tools/
  apply-prototype-style.js    apply_prototype_style 工具 + 一次性 prompt 段落
tests/                       159 项测试 + 探针负向测试 + DOM 垫片 + 从 DSH 产物抄来的夹具
tools/probe-host.mjs         ★ 宿主契约探针（读 app.asar）
tools/preflight.mjs          打包后自检
docs/01-architecture.md      架构与取舍的完整记录（§ 引用它，别在注释里重述）
docs/02-renderer-authoring.md 新增一个渲染器
```

`tests/ scripts/ tools/ tsdown.config.ts` 是仓库内工作流，不进包。

---

## 7. 新增一个渲染器的正确姿势

目标：**一个新文件 + 一行注册**（`src/client/index.js` 的 `RENDERER_FACTORIES`）。

渲染器要满足 `contract.js` 的 `Renderer`：`id`、`match(request)`、`create(host)`。
可选：`label`、`priority`，以及实例上的 `expand {toggle, isOn, available?, subscribe?}`。

**需要额外一步的情况**：引擎很大时要拆成 on-demand chunk，那会多出一个构建条目
（`tsdown.config.ts`）和一次 chunk 请求。这是诚实的代价，不是设计缺陷。
`docs/02-renderer-authoring.md` 有清单，包括四条 chunk 契约。

---

## 8. 升级 DSH 之后

```powershell
pnpm run probe      # 先看宿主契约有没有变
pnpm run check      # 再看类型、夹具与断言
```

1. `tools/asar-extract.ps1` 抽出新的 `CodeBlock` / `CodeCard.module.css` 与 shell 样式表
   （`tools/README.md` 记了 asar 头部格式的坑：`DATA_BASE = 8 + headerSize`，
   **不是** `16 + headerSize`，差 8 字节会让每个文件都读到前一个文件的尾巴）；
2. 核对 `src/client/dom-contract.js` 里的 DOM 形状与行号 —— **只有这一个文件**需要改；
3. `pnpm run check`；
4. 拷贝覆盖产物（§3）。

---

## 9. 不要做的事

- **不要**用 `remove_bundle` / `install_bundle` 更新已安装的插件（§3）。
- **不要**在 `styles.js` 的 CSS 注释里写反引号 —— 它在一个模板字面量里，
  反引号会**直接终止字符串**。`tsc` 会报一串莫名其妙的语法错，让人以为是别的地方坏了。
- **不要**给 `:hover` 和状态选择器写同权重的规则并让状态规则排在后面，那会静默吃掉 hover。
  见 §4.1 的例子。
- **不要**在客户端半体里读 `ctx.get(name)` 以外的成员（§5 的第 5 条）。
- **不要**把 `client/` 加进 `.gitignore`（§5 的第 7 条）。
- **不要**为了让测试通过而放宽断言。断言变红通常意味着代码错了，先查代码。
