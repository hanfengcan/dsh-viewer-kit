# dsh-viewer-kit 架构设计

> 目标：为 DeepSeek Harness（`dsh`）对话窗口提供**可插拔的内容渲染层**。
> 当模型输出 HTML / 图表 / 数据表时，用户可以在「预览」与「代码」之间切换；
> 未来新增渲染器（ECharts、数据表格、代码高亮、流程图……）**不需要改动内核和接缝代码**。

本文档是实现之前的架构决策记录。文中所有平台事实都标注了可复核的证据位置
（DSH 发行包内文件 + 行号）。核对基线：`@deepseek-ai/dsh@0.2.0-rc.2`。

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 验收标准 |
|---|---|---|
| G1 | HTML 代码块支持「预览 / 代码」切换 | 会话里出现 ` ```html ` 围栏时，代码块头部出现切换按钮，两种视图都能正常显示 |
| G2 | 渲染器可渐进添加 | **自包含**渲染器：新增 1 个文件 + 1 行注册，不修改 `core/` 与 `seam/` 任何代码。**带引擎**的渲染器见 §4.6 —— 还需要构建契约，这条主张对它是两档而非一档 |
| G3 | 零破坏性 | 不注册任何 DSH 已占用的 Slot；不重写 DSH 自带的组件；卸载插件后对话窗口完全复原 |
| G4 | 失败可降级 | 渲染器抛错、加载失败、内容超限，都退化为「原生代码块 + 一个提示」，会话不白屏 |
| G5 | 安全 | 模型产出的 HTML 在**不与宿主同源**的沙箱中渲染，默认禁用脚本 |
| G6 | 跟随宿主外观 | 只使用 `--dsw-*` 主题变量，明暗主题自动跟随 |

### 1.2 非目标（v0 明确不做）

- **不做** ECharts / 表格 / Mermaid 的具体实现。它们是 G2 的验收样例，不是 v0 的交付物。
- **不做** 对话窗口的整体接管（不注册 `conversation.chat.node` 的任何 key）。理由见 §3.2。
- **不做** 服务端渲染 / 导出。所有渲染发生在浏览器端。
- **不做** 修改模型行为（不注入 system prompt）。v0 完全被动：模型照常输出围栏代码块。

---

## 2. 平台事实核查

设计前先确认「平台到底提供了什么」，避免基于猜测设计。以下结论均可复核。

### 2.1 插件打包与加载

| 事实 | 证据 |
|---|---|
| 客户端插件在 `package.json` 声明 `dsh.client` | `dsh-client-ui-renderer/package.json:32-37` |
| 客户端半体导出 `./client`，产物是 `client/client.js` | `dshmarket/package.json:69`（社区插件实证） |
| 产物格式为 `window.__ModuleLoader__.load({ id, factory })`，factory 内的 `require` 解析基线模块表 | `dshmarket/client/client.js:1`、`dsh-experimental-client-ui-voice-input/lib/client.js:1-3` |
| 客户端半体导出 `apply(ctx)`；`ctx.effect` / `ctx.get` / `ctx.on` 可用 | `Builtin` 检查器返回的客户端内置符号 |
| Bundle 通过 `dsh.bundle.patch` 指向一个 `cordis.patch.yml`，以 `insert` 行挂进 profile | `dshmarket/cordis.patch.yml:2-4` |
| 插件卸载会连带清理其插入的样式 | `dsh-client-modules/README.md:42` |
| 标准客户端 bundle 由 **tsdown** 产出（官方与社区插件一致） | `dshmarket/package.json:26` (`build:client": "tsdown && …"`)、voice-input 同构 |

**推论 1**：本插件可以是一个**零运行时依赖、零 React** 的纯浏览器插件。
它不使用任何基线模块，所以产物里的 `require` 一次都不会被调用。

**推论 2**：构建走标准 tsdown 管线，而不是自研打包器。格式契约集中定义在
`tsdown.config.ts` 一处：`format: 'cjs'`（DSH 消费的不是 ESM）+ banner 里的
`window.__ModuleLoader__.load({ id, factory })` 外壳 + factory 内自建
`module` / `exports` 对（rolldown 的 CJS interop 前导假定它们已存在）。
`entryFileNames: '[name].js'` 把 tsdown 默认的 `client.cjs` 拉回 DSH 约定的
`client/client.js`。

### 2.2 Slot 系统（我们**不用**它，但必须知道它的边界）

| 事实 | 证据 |
|---|---|
| Slot 有 4 种：`single` / `list` / `keyed` / `chain` | `dsh-client-ui-slots/lib/index.js:163-190` |
| `keyed` / `list` / `single` 支持 `priority`，**低优先级即"遮蔽"**，同 key 同优先级重复注册会抛错 | 同上 `:168-186`，提示语原文：`register at a different priority to shadow it (lowest renders)` |
| 「声明即拥有」：子 slot 只有声明方能注册 | `dsh-client-ui-slots/README.md:46` |
| `conversation.chat.node` 是 `keyed`，key 域固定为 `ChatNodeKind`，`assistant-step` 已被占用 | Slot 实时检查器输出 |

**推论**：技术上**可以**用 `priority: -1` 遮蔽 `assistant-step`，但那样我们就得重写整个助手消息视图（见 §3.2）。

### 2.3 Markdown 渲染管线（关键）

助手消息正文的渲染路径是：

```
conversation.chat.node[key="assistant-step"]   →  AssistantNodeView
  └─ AssistantMarkdown
       └─ 每个 text block → MarkdownText          (primitives)
            └─ renderNode: case "code" → renderCode → <CodeBlock>
```

关键事实：

| 事实 | 证据 |
|---|---|
| `MarkdownText` 是一条**封闭**的自研 mdast→React 渲染器（不是 react-markdown），外部无法注入节点渲染 | `dsh-client-ui-primitives/lib/index.js:11168-11185` |
| 全文唯一可扩展的上下文是 `MarkdownDelegateContext`，它**只管链接跳转**（`openExternalLink` / `openFile` / `fileImages`），不涉及渲染 | 同上 `:11031-11061` |
| 围栏代码块渲染出的 DOM 带有**稳定、且被官方 CSS 注释称为"稳定内容节点"的钩子** | 见下表 |

`CodeBlock` 实际输出的 DOM 契约（`primitives/lib/index.js:10873-10914`）：

```html
<div class="…block md-code-block" data-code-wrap="true">
  <div class="…bannerWrap">
    <div class="…header" data-code-block-banner>      <!-- CodeToolbar -->
      <div class="…heading"><span class="…language">html</span></div>
      <div class="…actions">[wrap 按钮][copy 按钮]</div>
    </div>
  </div>
  <div class="…content" data-code-block-content>        <!-- ← 官方注释：stable content node -->
    <div class="shiki"><pre class="shiki css-variables">…</pre></div>
  </div>
</div>
```

其中官方 CSS 的原文注释是关键证据：

> `/* Consumers may turn the stable content node into a viewport without changing
>    the default CodeBlock layout. */`
> —— `dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css:73-76`

即：**DSH 自己就声明了这个节点是给外部消费者用的**。

另外两条对我们非常重要：

1. **语言名只出现在 banner 的文本里**，没有 `data-lang` 属性。→ 接缝必须从
   `[data-code-block-banner]` 的第一个 `span` 读取语言名。
2. **稳定态与流式态的 DOM 形态不同**：
   - 流式中：内容节点的子元素**就是** `<pre class="shiki">`；
   - 稳定后（已高亮）：子元素是 `<div class="shiki">`，`pre` 在 div 里面。

   这个差异天然就是"是否已结束流式输出"的判据，无需任何定时器（见 §6.3）。

---

## 3. 接入点选型：三条路，只有一条值得走

### 3.1 方案 A：遮蔽 `conversation.chat.node[assistant-step]`，自己重写助手消息

- 做法：`ctx.slots.register({name:'conversation.chat.node', key:'assistant-step', priority:-1}, MyView)`。
- 代价：必须重新实现 `AssistantMarkdown` 的**全部**行为——正文、思维链折叠行、图片分组、
  turn-process 内联、停止徽标、actions 行，以及 `conversation.chat.turnTail` /
  `conversation.chat.assistant-actions` 两个子 slot 的透传渲染，还有流式 shimmer 与
  presentation 策略。
- 风险：DSH 每次升级都可能改这块行为，我们跟一次坏一次；且没有"回退到官方实现"的手段
  （被遮蔽的 occupant 不对消费者暴露，`ctx.slots` 只有 `register` / `registerFactory` / `inject`）。
- 结论：**否决**。收益（一个围栏的切换按钮）远小于风险。

### 3.2 方案 B：新增一个 `viewer_render` 工具，让模型主动调用

- 做法：Host 半体注册一个工具 + 客户端注册 `tool.call.toolview[viewer_render]`（该 slot 的
  key 域是开放的，不遮蔽任何东西）。
- 优点：纯增量、零 DOM 操作、架构最干净。
- 缺点：**改变了内容形态**。模型必须"调用工具"而不是"输出围栏"，需要改 system prompt，
  且大段 HTML 塞进工具参数既费 token 又难续流。
- 结论：**保留，但降级为 v1 的第二条内容来源**（§7）。它对"结构化数据"（图表 spec、大表）
  仍然是对的形式，只是不能作为 HTML 预览的主路径。

### 3.3 方案 C（采纳）：把 `[data-code-block-content]` 当作**视口**，在其旁边挂载我们自己的渲染结果

- 做法：不碰 DSH 的组件与 Slot，只在它已经声明为"稳定内容节点"的位置挂载自己的 DOM。
- 优点：
  - **零遮蔽**、零重写、零 React 依赖；
  - 对 DSH 升级的耐受度高——只要那个 `data-code-block-content` 钩子还在，接缝就还能工作；
  - 与「内容从哪来」解耦，将来接工具来源、接文件预览，都不用改接缝。
- 代价：需要小心地与 React 的 reconciliation 共存。这部分被完整收敛到**一个文件**
  （`src/client/code-block-surface.js`），并写成显式不变量（§6.4）。
- 结论：**采纳**。核心架构建立在"接缝适配器"接口之上，接缝实现可替换（§9 迁移路径）。

---

## 4. 架构分层

```
┌───────────────────────────────────────────────────────────────────────┐
│ L5  Renderer        renderers/html.js  ·  renderers/echarts.js  ·  …   │  ← 插件作者的日常战场
│     实现 Renderer 契约；不 import 任何 L1-L4 的内部实现                  │
├───────────────────────────────────────────────────────────────────────┤
│ L4  Kit Core        kit.js  ·  view-state.js  ·  contract.js          │  ← 零 DOM、零 React、可单测
│     注册表 · 协商算法 · 视图状态 · 标识符与语言归一化                     │
├───────────────────────────────────────────────────────────────────────┤
│ L3  Host Surface    code-block-surface.js                             │  ← 内容宿主（视口）
│     一个 surface = 一个代码块；负责开关控件 + 挂载渲染器实例              │
├───────────────────────────────────────────────────────────────────────┤
│ L2  Source          由 L1 产出的 RenderRequest 流                      │  ← 内容来源抽象
│     v0: 围栏代码块    v1: 工具调用结果                                  │
├───────────────────────────────────────────────────────────────────────┤
│ L1  Seam Adapter    dom-seam.js                                        │  ← 唯一与 DSH DOM 耦合的层
│     发现 / 回收 surface；流式守卫；生命周期                              │
└───────────────────────────────────────────────────────────────────────┘
```

**依赖方向严格向下**。L5 只能看到 L4 暴露的接口；L4 不知道 DOM 存在；L1/L3 不知道
具体有哪些渲染器。因此：

- 加一个**自包含**渲染器 → 只碰 L5（+ 一行注册）。
- 加一个**带引擎**的渲染器 → 还碰构建契约与 L1 的识别判据，清单见 §4.6。
- 换掉接缝（比如将来 DSH 提供了真正的渲染扩展点）→ 只碰 L1/L3，L4/L5 零改动。

### 4.6 两档渲染器：这条主张的边界（实测修正）

架构原本的主张是"加渲染器 = 一个文件 + 一行"。**这对 `table` 成立，对 `echarts` 不成立**，
而两个都是真实交付物，所以主张必须写成两档，而不是留一个已知不准的承诺。

| | 自包含渲染器（`table`、将来的 Mermaid） | 带引擎渲染器（`echarts`） |
|---|---|---|
| 新增文件 | `renderers/x.js` | `renderers/x.js` + `chunks/x.js` + `chunk-loader.js`（一次） |
| `index.js` 注册 | 1 行 | 1 行 |
| `tsdown.config.ts` | 不动 | 第二个 entry + 逐 chunk 的 `banner` + 可能需要的 `define` |
| L1 接缝 | 不动 | **可能必须动** —— 见下 |
| 包体 | 几 KB | 引擎独立成文件，按需 fetch |

**为什么 L1 可能必须动（这一条最值钱）**：DSH 的 `CodeToolbar` 渲染
`supportsHighlighting(lang) ? lang : <fallback>`，而 `LANG_ALIASES` 是 Shiki 内置表、
**不支持自定义**。所以 ` ```echarts ` 的 banner 上写的是"代码块"，**原始语言名在 DOM 里
根本不存在**（也没有 `data-lang` 之类的后备）。

`table` 之所以没暴露这个问题，是因为它认领的 `csv` / `json` / `markdown` **都在 Shiki 表里**，
banner 会显示真名。**任何 Shiki 不认识的围栏语言，语言名都拿不到。**

修法是让识别**不依赖语言名**：通用标签 → 语言置空 → 由渲染器按内容认领。
流式安全不靠定时器猜 —— 流式中的 JSON 解析不了，内容判据自然不通过，等补全的那次
mutation 到达即被认领。**改动在 L1，所以它不属于"只碰 L5"。**

> 写这条修正的直接原因：我自己就是先按"一个文件 + 一行"写的文档，再写 `echarts`，
> 然后发现要动四处。**文档承诺的范围一旦大于实际，后来者会按错误的成本估算动手。**

---

## 5. 核心契约

### 5.1 `RenderRequest` — 被归一化的"一段可渲染内容"

```ts
interface RenderRequest {
  /** 稳定标识：同一段内容在重渲染/滚动回来后仍是同一个 id（用于记忆视图状态）。 */
  id: string
  /** 来源表面种类，当前仅 'code-block'；为将来的 'tool-call' / 'document' 预留。 */
  surface: 'code-block' | 'tool-call' | 'document'
  /** 归一化后的语言标识（小写、去首尾空白）；无语言时为 ''。 */
  lang: string
  /** 原始文本，未做任何裁剪或转义。 */
  source: string
  /** 供渲染器自行判断的附加信息（如 fence 上是否存在 meta 串）。 */
  meta?: { info?: string }
}
```

### 5.2 `Renderer` — 渲染器契约

```ts
interface Renderer {
  /** 全局唯一 id，也是优先级相同时的确定性排序键。 */
  id: string
  /** 展示名（工具栏下拉、错误提示用）。 */
  label?: string
  /** 数值越大越优先。默认 0。 */
  priority?: number
  /**
   * 认领判定。返回 true 表示"我来渲染"。
   * 可以只看 lang，也可以解析 source 做内容嗅探（例如 JSON 数组 → 表格）。
   * 必须便宜且无副作用。
   */
  match(request: RenderRequest): boolean
  /**
   * 创建渲染实例。返回 null 表示"现在不渲染"（例如内容超限），
   * 此时该 surface 保持原生外观，不显示开关。
   */
  create(host: RenderHost): RendererInstance | null
}

interface RenderHost {
  request: RenderRequest
  /** 建节点用的 document。 */
  document: Document
  /** 挂到 surface 自己的视图容器里。每次 enter 前该容器已被清空，
   *  所以渲染器不需要管理自己的容器。 */
  mount(node: Node): void
  /** 清空视图容器。 */
  clearView(): void
  /** 供渲染器遵守的尺寸上限。 */
  limits: { maxSourceBytes: number; maxPreviewHeight: number }
  /** 渲染器内抛错时调用：外壳降级为原生代码块并提示。 */
  fail(error: unknown): void
  /** 读取当前配置（只读快照）。 */
  config(): ViewerKitConfig
}

interface RendererInstance {
  /** 本渲染器支持的视图，如 ['preview','code']；至少一个。 */
  views: ViewDescriptor[]
  /** 进入某个视图。宿主已保证同一实例上 'code' 视图永远可用。 */
  enter(viewId: string): void | Promise<void>
  /** 离开实例（宿主即将卸载）。释放 iframe、定时器、观察器。 */
  dispose(): void
}

interface ViewDescriptor {
  id: string
  label: string
}
```

**为什么 `match` 与 `create` 分开**：`match` 是纯判定，宿主可以缓存；`create` 有副作用
（建 iframe、起定时器），只在真正需要时才调用，且必须可失败。

**为什么宿主保证 `'code'` 视图总可用**：切换回代码时，最安全、最省资源的做法是
**把原生 `<pre>` 原封不动地显示回来**——不做二次渲染，零失真。渲染器只需要实现 `preview`。

### 5.3 `Kit` — 门面（L4 对外唯一 API）

```ts
interface Kit {
  /** 注册一个渲染器，返回注销函数。重复 id 直接抛错（配置错误应当早失败）。 */
  register(renderer: Renderer): () => void
  /** 已注册渲染器的只读快照（按优先级降序）。 */
  renderers(): readonly Renderer[]
  /** 协商：返回优先级最高、且 match 为真的渲染器。无匹配返回 null。结果按内容 id 缓存。 */
  negotiate(request: RenderRequest): Renderer | null
  /** 视图状态：读 / 写 / 订阅。 */
  getView(id: string): string | undefined
  setView(id: string, viewId: string): void
  subscribe(listener: () => void): () => void
  /** 首次见到的一段内容默认打开哪个视图。 */
  defaultView(): string
  /** 构造 RenderRequest 的唯一入口，保证 id 与各字段不会走偏。 */
  buildRequest(input): RenderRequest
  /** 尺寸闸门：在任何渲染器看到内容之前拒绝超限内容。 */
  withinLimits(request: RenderRequest): boolean
  /** 绑定到一个具体挂载点，得到交给渲染器的 RenderHost。 */
  hostFor(request, fail, surface): RenderHost
  /** 构造实例；任何失败都转成 null，让调用方落回原生代码块。 */
  instantiate(renderer, request, host): RendererInstance | null
  /** 该实例的视图清单 = 渲染器自己的视图 + 宿主永远提供的 'code'。 */
  viewsOf(instance): ViewDescriptor[]
  /** 记一次"检查过的块"；被认领时带上 renderer id。 */
  noteSurface(rendererId?: string): void
  /** 换配置并清空协商缓存，使设置改动立即生效、无需刷新。 */
  setConfig(patch): void
  /** 配置的只读快照。 */
  config(): Readonly<ViewerKitConfig>
  /** 统计信息，供设置页与自检展示。 */
  stats(): { surfaces: number; claimed: number; byRenderer: Record<string, number> }
}
```

`Kit` 内部**不持有任何 DOM 引用**，因此可以在 Node 里直接单测（见 §10）。
`instantiate` / `hostFor` 之类也刻意写成不依赖 `this` 的闭包，
这样调用方把方法从 `kit` 上解构下来也不会坏。

### 5.4 协商算法

```
候选 = renderers.filter(r => r.match(request))
胜出 = 候选按 (priority 降序, id 升序) 取第一个
```

- `id` 升序做 tie-break，是为了保证**加载顺序不影响结果**（DSH 的插件加载顺序不确定）。
- 胜出渲染器创建实例失败（返回 null 或抛错）时：**不再回退到次优渲染器**，
  而是保持原生代码块。理由：静默换用另一个渲染器会让用户困惑（"我明明装了两个"），
  明确的不渲染更可预测。若要支持回退，应由渲染器自己在 `match` 里表达优先级。

### 5.5 视图状态模型

```
key   = hash(scope + '\0' + lang + '\0' + source)
value = 'preview' | 'code' | 渲染器自定义 viewId
```

- **不按 DOM 元素存**：DOM 元素会被 React 重建，按元素存必然丢状态。
- **按内容指纹存**：同一段代码在会话里出现多次（上文重复引用）时共享视图选择，
  这符合直觉；内容一变，指纹变，视图重置为该渲染器的 `defaultView`。
- **作用域**：`scope` 取最近的 `[data-chat-node-key]` 祖先。这样**同一条消息**里
  重复出现的同一段代码共享视图选择，而**不同消息**里的同一段代码互不影响——
  比"按会话共享"更精确，代价为零。
- **指纹算法**：两遍 FNV-1a（不同 salt）+ 长度。碰撞最多导致两段不同的代码共用一个
  *视图选择*，绝不会导致内容渲染错误，但两遍之后实际不可能发生。
- **持久化**：`sessionStorage`。会话内记忆，但**不写进磁盘**——
  渲染器升级后旧的 viewId 可能已不存在，启动时读到未知 viewId 一律回落到默认视图。
  读取时用内存镜像缓存，避免每次切换都重新 `JSON.parse`。

---

## 6. 接缝设计（L1 + L3）

这是整个插件里**唯一允许直接操作 DSH DOM** 的地方，也是风险最集中的地方。
因此规则必须写死并可验证。

### 6.1 定位

```js
// 1. 找到所有渲染出的代码块。
//    注意：data-code-block-banner 在 banner（header）上，不在代码块根上，
//    所以选择器只有 .md-code-block；找不到 banner 的块会被 surface 拒绝。
document.querySelectorAll('.md-code-block')
// 2. 提取语言名（唯一来源是 banner 里的语言文本）
banner.firstElementChild.firstElementChild.textContent
// 3. 提取源码（稳定态的 pre 文本）
content.querySelector('pre').textContent
```

选择器全部集中在 `src/client/dom-contract.js` 这一个文件里，每条都附了
"这段 DOM 来自哪个包的哪个函数"的可复核引用。**升级 DSH 时只需要核对这一个文件。**

### 6.2 发现与回收

用一个 `MutationObserver`（`childList + subtree`，观察 `document.body`），
配合一次全量扫描，处理三类变化：

| 情况 | 处理 |
|---|---|
| 新代码块出现 | 建立 surface |
| 已知 surface 的 DOM 被 React 重建 | 丢弃旧状态，重新建立 |
| 代码块被移除 | 调用 `instance.dispose()`，从索引中移除 |

用 `WeakMap<Element, SurfaceRecord>` 保存索引，天然随元素回收。

### 6.3 流式守卫（不靠定时器猜）

判据来自 §2.3 的 DOM 形态差异：

```
内容节点的 elementChild 是 <div>  → 稳定态（已高亮）→ 立即接管
内容节点的 elementChild 是 <pre>  → 流式态              → 跳过
```

对于**不支持高亮**的语言（如 ```` ```text ````），DSH 直接渲染 `plain` 分支且流式期间
会持续变化。此时退化为"内容节点连续 300ms 未变更"才接管。

**这条规则的价值**：流式期间绝不接管，因此不存在"预览在打字过程中不停重建 iframe"的问题。

> **重试是有界的。** 真正负责发现"围栏闭合"的是 MutationObserver：DSH 换掉内容节点的
> 子元素是一个我们看得见的 `childList` 变更。定时器只是兜底——防止某次变更在节点
> 拿到最终形态之前就到了。因此重试次数有上限（`MAX_QUIET_RETRIES`，约 30s 静默后放弃），
> 否则一个永远不 settle 的块会让一个定时器空转到页面结束。

> **曾经踩过的坑**：`data-chat-running` 看起来是天然的"这一回合还在跑"信号，
> 但它挂在 `RunningStatus` 上——回合**内容之后**的一个"深度思考中"指示器，
> 是 flow item 的**兄弟节点而非祖先**（`dsh-client-ui-chat/lib/client.js:3918-3920`）。
> 所以 `element.closest('[data-chat-running]')` 对任何代码块都返回 `null`，
> 那个守卫**一次都没生效过**，是纯死代码。已删除，并在
> [`dom-contract.js`](../src/client/dom-contract.js) 里留下记录，
> 免得有人再犯同样的错。流式保护真正靠的是上面的形态判据。

### 6.4 与 React 共存的不变量（承诺）

> 以下五条是本插件对宿主 DOM 的全部写操作，越界即视为 bug：

1. **只增不删**：只在 `[data-code-block-content]` 里**追加**一个带
   `data-dvk-root` 标记的自有节点；永不删除、移动或改写任何 DSH 创建的节点。
2. **可见性用样式而非移除**：切换视图时，只改内容节点上**我们自己的** `data-dvk-mode`
   属性，由本插件的样式表决定谁可见。React 不会清除它没有设置过的属性。
   切回代码时还会把自有容器清空——所以"代码视图"是**零成本**的：不建 iframe，
   不重绘，不失真。
3. **控件挂在 banner 的操作组**：作为 `[data-code-block-banner]` 最后一个子节点
   （也就是 `actions` 组）的最后一个子节点追加。该组的子节点由 React 按下标协调，
   长度恒定（wrap + copy），多出的第 3 个节点 React 既不会认领也不会回收。
4. **不碰 `<pre>` 的 innerHTML**：原生代码内容始终保持原样，切回 `code` 是零失真。
5. **卸载即复原**：插件停用时移除所有自有节点与自有属性，不留残迹。

> **为什么第 5 条是承诺而不是副作用**：DSH 的模块系统保证"禁用条目会等待其异步效果
> 结束后再驱逐未使用的模块和样式"（`dsh-client-modules/README.md:42`），
> 所以我们必须把自己的清理挂在 `ctx.effect` 的 disposer 上。

> **第 3 条有一个我们依赖的细节**：`actions` 组里那个可选的 `status` 元素会导致
> React 在最前面插入一个 DOM 节点，把我们的节点整体后移一位。视觉效果仍然是
> "在换行/复制按钮左边"，但如果将来观察到错位，第一个要查的就是这里。

### 6.5 降级矩阵

| 情况 | 行为 |
|---|---|
| 无渲染器认领 | 原生代码块，不加任何东西 |
| 渲染器 `create` 返回 null | 原生代码块，不加开关 |
| 渲染器只有 1 个视图（没有增强视图） | 原生代码块，不加开关——加一个永远切不动的按钮是噪音 |
| 渲染器 `create` 抛错 | 原生代码块，控制台记一次带 renderer id 的错误 |
| 源码超过 `maxSourceBytes` | 原生代码块，不加开关（`negotiate` 之前就拒绝） |
| 宿主 DOM 结构变化（选择器失配） | 逐块降级为 no-op，控制台告警，对话窗口不受影响 |
| 宿主没有 `MutationObserver` | 接缝整体停用并告警一次，插件变成纯装饰（不崩） |

---

## 7. 内容来源

### 7.1 v0：围栏代码块（`surface: 'code-block'`）

被动。模型不需要知道本插件存在。认领完全由渲染器的 `match(request)` 决定。

### 7.2 v1：`viewer_render` 工具（`surface: 'tool-call'`）——为结构化内容预留

当内容本身不是"一段代码"而是"一份数据"时（ECharts option、大宽表、JSON schema），
围栏形式很别扭：一个几百 KB 的 JSON 塞进围栏既费 token 又无法增量阅读。
届时新增 Host 半体工具 `viewer_render({ format, source })`，
客户端在 `tool.call.toolview[viewer_render]`（开放 key 域，不遮蔽）里渲染。

**它与 v0 共用同一条管线**：工具结果被归一化成同样的 `RenderRequest`，
交给同一个 `Kit` 协商。因此新增这条来源**不改动 L3/L4/L5**。
这是"来源"与"渲染"分离的直接收益。

---

## 8. 安全模型

模型产出的 HTML 是**不可信输入**（可能来自被注入的网页、被污染的仓库文件）。

| 风险 | 措施 |
|---|---|
| 预览页读取宿主 DOM / cookie | `<iframe sandbox>` **绝不**同时给 `allow-same-origin` 和 `allow-scripts` |
| 默认执行脚本 | 默认 `sandbox=""`（完全禁脚本）；配置项 `html.allowScripts` 显式开启后才用 `sandbox="allow-scripts"` |
| 外泄来源 | `referrerpolicy="no-referrer"` |
| 网络访问 | 开启脚本后仍不注入任何宿主 API；如需断网由用户自行在沙箱文档内声明 |
| 高度撑爆布局 | `maxPreviewHeight` + 内部滚动 |
| 逃逸到新窗口 | v0 **不提供**"在新标签页打开"（那会以宿主同源打开，不可控）。若将来提供，必须显式二次确认并在文档中写明风险 |

> 之所以把"新标签页打开"排除在外：宿主页用 `blob:` URL 打开会以宿主同源执行，
> 这正好绕开了 iframe 沙箱提供的全部保证。这是一个容易被忽视的降级。

---

## 9. 迁移路径（接缝可替换性）

`L1/L3` 被刻意压缩到两个文件，它们的输出是一组 `RenderRequest`。
如果将来 DSH 提供了官方渲染扩展点（例如 `conversation.chat.node` 之外的新 slot，
或 markdown 渲染器暴露节点扩展），只需：

1. 新写一个 `Surface` 实现，产出相同的 `RenderRequest`；
2. 保留 `code-block-surface.js` 作为回退；
3. `dom-seam.js` 里按能力探测选择实现。

`L4 Kit` 与 `L5 Renderers` **一行都不用改**。这是把接缝做成"适配器"而不是"框架"的意义。

---

## 10. 测试策略

| 层 | 测试方式 | 理由 |
|---|---|---|
| L4 Kit | Node 下直接单测（无 DOM 依赖） | 协商、优先级、视图状态是纯逻辑，必须可测 |
| L1 接缝 | 用**从 DSH 真实产物抄下来的 DOM 片段**做夹具，在轻量 DOM 垫片上跑 | 不依赖浏览器即可验证接缝逻辑 |
| L3 Surface | 同上，夹具驱动 | |
| L5 渲染器 | 每个渲染器自带夹具 + 断言 | |
| **产物本身** | 把构建出的 `client/client.js` 塞进一个假的 `__ModuleLoader__` 里真跑一遍 | 测的是 DSH 真正会serve 的那份文件，而不是源码 |
| 端到端 | 安装到 profile 后人工验证 | 自动化 E2E 成本过高，v0 不做 |

> DOM 垫片（`tests/dom-shim.mjs`）只需实现接缝实际用到的 API（元素创建、属性、
> 一个真的小型 CSS 选择器引擎、`MutationObserver`、`sessionStorage`），
> 而不是完整的浏览器环境——因为接缝**只用**这些。
>
> 这套垫片 + 夹具不是摆设，它在开发过程中真的抓到了四个 bug：
> 选择器把 banner 属性错配到代码块根上、渲染器拿不到挂载点、
> 接缝漏传翻译函数、以及接缝依赖全局 `Element` 构造器。

---

## 11. 渐进式演进路线

| 阶段 | 新增内容 | 触及的层 | 状态 |
|---|---|---|---|
| v0 | Kit + 接缝 + HTML / SVG 渲染器 | 全部（基线） | ✅ 已实现 |
| v0.1 | 数据表格渲染器（CSV / JSON 对象数组 / 管道表格） | **仅 L5** | ✅ 已实现 |
| v0.2 | `html` 渲染器的脚本开关 / 高度设置（接线到设置项） | L5 + 配置 | 计划 |
| v0.3 | ECharts 渲染器（`echarts` 围栏 + JSON 嗅探） | **仅 L5** | 计划 |
| v0.4 | 代码高亮增强（扩展 DSH 的 shiki 语言表） | **仅 L5** | 计划 |
| v1 | `viewer_render` 工具来源（§7.2） | L2 + Host 半体 + 一个 toolview | 计划 |
| v1+ | 设置页（`settings.general.item`）+ 每会话开关 | 独立小模块 | 计划 |

**每一行都只触及标注的那一层**，这是本架构存在的全部意义。
v0.1 已经是这个说法的实证：新增数据表格渲染器时，
`kit.js` / `dom-seam.js` / `code-block-surface.js` / `contract.js` 一行都没有改动，
也没有新增任何 DOM 选择器或测试夹具。

---

## 12. 已知风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| DSH 移除 `data-code-block-content` 钩子 | 中 | 选择器集中在 `dom-contract.js` + 逐块降级为 no-op（§6.5） |
| DSH 改变 banner 内部结构导致读不到语言名 | 中 | 读不到即 `lang: ''`，交由渲染器内容嗅探；仍失配则不接管 |
| React 与我们的追加节点发生协调冲突 | 低 | §6.4 的五条不变量 + `data-dvk-*` 标记便于事后自检 |
| 预览页消耗过多内存（大量 iframe） | 低 | 只在用户切到预览时创建 iframe；切回代码立即移除节点（连带销毁浏览上下文） |
| 用户禁用插件后残留 UI | 低 | 清理挂在 `ctx.effect` disposer 上（DSH 保证等待异步效果结束再驱逐） |
| 安装方式被后续操作冲掉 | — | **已实测发生过并已修复**，见 §13.4 |

---

## 13. 已被实证的部分

写完代码之后，下面这些不是"应该可以"，而是实际验证过的：

### 13.1 打包与激活

包通过 `dsh plugin add file:<仓库路径>` 装进 profile 之后：

- 它出现在 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里；
- 它的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`，由插件管理器生成 Loader 那一行；
- `plugin_manager list_plugins` 显示
  `include:dsh-viewer-kit / enabled: true / fiberPhase: "active"`；
- 装进 profile 的 `client/client.js` 与本仓库构建产物 **SHA-256 完全一致**——
  也就是说宿主 serve 的确实是我们构建的那份文件。

### 13.2 零遮蔽

激活后查询 `conversation.chat.node` 的 occupant 表，19 个原生 renderer 全部
`registrant: "mf"`、`priority: 0`、`active: true`——**本插件一个 Slot 都没注册**。
这不是"应该不影响"，是实时 Slot 表读出来的结果。

### 13.3 产物与逻辑

- 构建产物在一个假的 `__ModuleLoader__` 里成功注册、导出 `apply(ctx)`，
  并对一个真实夹具走完了"接管 → 挂 iframe → 卸载复原"全流程。
  这一步跑的是 **tsdown 产出的那份 `client/client.js`**，不是源码——
  所以格式契约（banner/footer、`module`/`exports` 对、`[name].js` 命名）
  被真实加载验证过，而不是"看代码觉得对"。
- 40 项自动化测试全绿（`pnpm run check`：typecheck + tsdown build + tests）。
  仓库用 `.node-version` 声明 Node 24；tsdown 需要 ≥ 22，而 `pnpm run` 用 PATH 上的
  `node` 拉子进程，所以必须显式选版本（`fnm use` / `fnm exec --using=24 -- …`，
  后者能把版本穿透到嵌套进程）。
- `tsc --noEmit` 对 `src/**/*.js` 的 JSDoc 做检查，第一次跑就抓出了 5 个真实类型错误
  （跨文件的 `ViewerKitConfig` 没有限定模块名、`iframe` 被标注成 `Element` 而丢掉了
  `srcdoc`/`style`、`safeStorage()` 的返回类型声明与实现不符）。
  这是引入标准工具链的直接收益。

### 13.4 一次真实的翻车：手改 profile patch 撑不住

最初是把包复制进 profile 的 `node_modules`、再手动往 profile 的
`cordis.patch.yml` 末尾加一行 `insert`。DSH 立刻通过 `app-boot/config-reload`
把它热加载了，`fiberPhase` 变成 `active`——看起来完全成功。

**然后它消失了。** 后来有人在同一个 profile 上跑 `dsh plugin add`（装了
`dsh-schedule-later`、升级了 `dshmarket`），整个 `cordis.patch.yml` 被重写，
我那一行连同上下文一起没了，插件静默失效——既没有报错，也没有任何提示。

> **教训**：热加载成功 ≠ 安装是持久的。Loader 的那一行是**生成物**，
> 手改它就是在跟生成器赛跑。
>
> 正确做法是让插件管理器成为唯一的写入者：包通过 `dsh plugin add` 进入
> `dependencies` 和 `profile.bundles`，Loader 那一行变成可再生的派生物。
> 之后同样的安装操作不会再影响它。
>
> 这条已经写进 [README](../README.md#快速开始) 的显著位置。

**尚未在真实浏览器里验证的**：切换按钮的实际观感与交互。
这需要刷新一次页面让客户端模块系统去取新的 bundle，属于一步人工操作。

### 13.5 排查"装了但没渲染"：三个静默失败，与一次自我纠正

用户报告"插件已使能，但会话里的 HTML 没渲染"。宿主 `/plugins` 路由对未认证请求一律 404
（连乱写的路径也是），所以无法从命令行确认浏览器侧行为，只能靠 `window.__DSH_BOOT__`
和控制台自检。排查中确认了三件事，其中一件推翻了我自己的判断：

**1. 自研打包器是错的方向，已换成标准 tsdown 管线。**

最初为了"零依赖"自己写了个 ESM→`__ModuleLoader__` 链接器。它能用，但它是**非标准**的：
官方和社区插件都用 tsdown，格式契约应该由配置声明，而不是由我手写的
正则变换保证。已删除 `scripts/build.mjs`，改用 `tsdown.config.ts`。
第一次跑 `tsc --noEmit` 就抓出 5 个真实类型错误——这就是标准工具链的价值。

**2. pnpm 是"拷贝"目录依赖，不是硬链接（我一开始判断错了）。**

我一度认定是构建脚本 `rm -rf client/` 打断了硬链接。**那个判断是错的**，
用追加探针标记的实验证伪了：改仓库里的 `client.js`，profile 里那份纹丝不动。
真实原因是 pnpm **拷贝**目录依赖进 `node_modules`，所以

> 改完代码后的正确流程是：`pnpm run build` → 重新安装 → 刷新页面。

只构建不重装，profile 会一直 serve 上一次安装的内容，而且**任何地方都不报错**。
`install_bundle` 在 lockfile 未变时会回 `Already up to date` 并拒绝重装，
所以要真正同步，得 `remove_bundle` + `install_bundle` 或提升 `version`。

**3. `data-chat-running` 流式守卫是死代码。**

它挂在 `RunningStatus`（回合内容**之后**的指示器）上，是 flow item 的**兄弟节点
而非祖先**，所以 `closest('[data-chat-running]')` 对代码块永远返回 `null`。
流式保护实际靠的是内容节点的形态判据。已删除该守卫并补上了有界的兜底重试，
在 `dom-contract.js` 留下记录说明它**不是**作用域标记。

> 这三条都属于同一类问题：**失败是静默的**。所以补了两个控制台钩子：
> `__DSH_VIEWER_KIT_BOOTED__`（bundle 被求值时打点，用来区分"bundle 根本没进 boot graph"
> 和"进了但 `apply` 没被调用"）与 `__DSH_VIEWER_KIT__.diagnose()`（把
> "没有代码块" / "没被认领" / "还没稳定" 三种情况分开，每种对应一个具体修法）。

**仍未定论的**：`dsh-viewer-kit` 是否出现在 `window.__DSH_BOOT__.entries` 里。
用户提供的快照中三个社区 bundle 都不在，而用户报告另外两个插件**工作正常**，
因此那次快照很可能取自"本插件被 profile 重写冲掉、尚未重装"的时间窗。
这个疑问后来被 §13.6 的崩溃日志**绕过**了：那条线索本身是对的，但根因在别处。

### 13.6 真正的根因：`apply()` 抛异常，导致 DSH 启动崩溃

用户报告"重启 dsh 就 crash，然后 `cordis.patch.yml` 被重置"。崩溃日志给出了判决：

```
Error: web boot: 1 entry did not activate
dsh-viewer-kit: failed
```

前端 boot 审计的判定逻辑（`dsh-web-frontend/dist/assets/index-*.js`）是：

```js
if (entry.fiber === undefined) → `${name}: import failed: ${importError.message}`
const state = A7[entry.fiber.state]
if (state !== 'active')        → `${name}: ${state}`
```

日志只有 `dsh-viewer-kit: failed`，**没有** `import failed: …` —— 所以不是传输/导入失败：
bundle 加载了、factory 跑了、entry 建起来了，**然后 `apply(ctx)` 抛了异常**。
DSH 把这个失败当成致命启动错误；而"patch 被重置"正是 **DSH 自己的启动失败恢复**，
不是别人跑了 `dsh plugin add`——我之前那个判断也是错的。

**三个 bug，都是同一个错误的世界观造成的：我以为 `ctx` 是个宽松的对象、
`ctx.effect` 是个"注册清理"的容器。** 真实契约窄得多，而且严格得多：

| # | 症状 | 真因 |
|---|---|---|
| 1 | **DSH 崩溃** | `ctx.MutationObserver` —— `ctx` 是 proxy，读未注册成员**直接抛**。builtin 文档原话就是"prefer `ctx.get(name)` with an undefined check"。 |
| 2 | 什么都没渲染 | `ctx.effect(dispose, label)` —— `effect` **立刻调用**回调，并把**返回值**当 disposer。我传的是已经写好的 `dispose`，于是插件在激活瞬间把自己拆干净了（`__DSH_VIEWER_KIT__` 因此是 `undefined`）。 |
| 3 | 即使不崩也不渲染 | `locale.bind(ns).t(key)` —— `bind` 返回的就是翻译函数本身（`t = ctx.locale.bind(NS); t('key')`），不是带 `.t` 的对象。这个 TypeError 被接缝的逐块 try/catch 吞掉，看起来和"没有渲染器认领"一模一样。 |

**为什么我自己的测试没抓到**：我给 `apply` 喂的是一个**宽松的** `ctx` stub ——
任意属性都返回 `undefined`，`effect` 只是把回调存起来不调用。
真正运行时的三个约束（未注册成员抛错、`effect` 立即执行、`bind` 的返回形状）
一个都没建模。**测试通过只证明测试的模型是对的，不证明产品是对的。**

**修法与防线**：

1. 对 `ctx` 的依赖压到只剩两个成员：`ctx.get(name)` 与 `ctx.effect(cb)`。
   `document` / `console` / `MutationObserver` 一律走浏览器全局；
   样式表自己插 `<style data-plugin="dsh-viewer-kit">` 并在 disposer 里移除
   （这正是官方 UI 包的做法），不再依赖来路不明的 `styles` 助手。
2. 新增 `tests/ctx-harness.mjs`：一个**严格**的客户端上下文 ——
   proxy 读未注册成员即抛、`effect` 立即执行且要求回调返回 disposer、
   `locale.get('locale')` 用真实 locale 注册表的语义（含它的两个 throw）。
   任何违反都会变成测试失败，而不是线上崩溃。
3. `tests/repro-activation.mjs`（`pnpm run repro`）用同一套 harness 跑**构建产物**，
   失败时打印栈 —— 因为崩溃日志里只有 `<name>: failed`，真正的栈只进浏览器控制台。
4. `pnpm run check` = typecheck + build + 46 项测试 + repro，全部必须绿。

> **教训**：写插件的"接口"部分时，**先读契约，再写代码**。
> 我三次都是先写、再假设运行时"应该"怎样，代价是让用户的 DSH 崩了两次。
> 一个宽松的 stub 是比没有测试更坏的东西——它给出虚假的安全感。

**尚未在真实浏览器里验证的**：修复后的实际渲染效果。
三个 bug 都由严格 harness 复现并验证修复，但 harness 仍然是我对运行时的建模，
不是你机器上那个运行时。所以重新启用前应先征得用户同意。
