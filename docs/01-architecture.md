# dsh-viewer-kit 架构

本文按**已建成的代码**说明插件：每一层的职责、跨层契约、判据的表达式与常量值，
以及每条宿主依赖的证据位置（DSH 发行包内文件 + 行号）。
核对基线：`@deepseek-ai/dsh@0.2.0-rc.2`。

平台里**看起来是某样东西、实际不是**的事实，与已排除的方案，在
[03-pitfalls.md](03-pitfalls.md)。写新渲染器的步骤与契约，在
[02-renderer-authoring.md](02-renderer-authoring.md)。命令与房子规矩在
[AGENTS.md](../AGENTS.md)。

---

## 1. 分层

| 层 | 文件 | 职责 | 允许知道 |
|---|---|---|---|
| L5 渲染器 | `renderers/html.js` `table.js` `echarts.js` | 实现 `Renderer` | 只有 `RenderHost` 给的东西 |
| L4 内核 | `kit.js` `contract.js` `view-state.js` | 注册表 · 协商 · 视图状态 · 统计 | **零 DOM**，可在纯 Node 下测 |
| L3 宿主表面 | `code-block-surface.js` | 一个 surface = 一个代码块 | DSH 的 content / banner 节点 |
| L1 接缝 | `dom-seam.js` | 发现 · 回收 · 认领门 · 生命周期 | DSH 的 DOM 形状 |
| — 滚动 | `scroll-guard.js` | 抵消认领造成的高度位移 | 一个元素 + 其祖先 |
| 宿主半体 | `src/index.js` `src/schema.js` `src/tools/` | 配置校验与发布 · 原型模式 | Node 侧，不碰 DOM |

依赖严格向下：L5 只能看见 L4 暴露的接口，L4 不知道 DOM 存在，
L1/L3 不知道有哪些渲染器。

**`RenderRequest` 在 L3 构造**（`code-block-surface.js:102` 调 `kit.buildRequest`）。
L1 只读 DOM，把 `root` / `source` / `lang` / `info` / `scope` 往下传，
自己不构造请求对象。

### 1.1 加一个渲染器的成本，两档

| | 自包含（`table`） | 带引擎（`echarts`） |
|---|---|---|
| 新增文件 | `renderers/x.js` | `renderers/x.js` + `chunks/x.js` + `chunk-loader.js` |
| `index.js` 注册 | 1 行 | 1 行 |
| `tsdown.config.ts` | 不动 | 第二个 entry + 逐 chunk 的 `banner` + `define` |
| L1 识别判据 | 不动 | **可能必须动** —— 见 §5.4 |

---

## 2. 宿主契约

本插件依赖 DSH 若干**没有公开文档**的行为。凡在 `tools/probe-host.mjs`
覆盖范围内的，本文在条目上标「探针守着」。

### 2.1 boot 线缆不带配置

```
宿主产出   graphRow() → { id, url, rev, inject?, immediately?, external? }
浏览器消费 parseBootManifest() → 逐字段白名单，其余一律丢弃
建 entry    const options = { name: id }        ← 没有 config 键
```

所以客户端的 `apply(ctx, rowConfig)` 拿到的 `rowConfig` **恒为 `undefined`**
（`src/client/index.js:213` 仍保留了一个优先使用它的分支，见 §3.3）。
探针守着：`the boot wire still carries no config, so P0 is still open`。

### 2.2 CodeBlock 的 DOM —— 有两个分支

`@deepseek-ai/dsh-client-ui-primitives/lib/index.js:10873-10914`。
**形状随 props 变**，这是 §5.4 那条认领门存在的原因：

```
有 toolbarLabels（会话里常见）
  <div class="<block> md-code-block">
    <div class="<bannerWrap>">
      <div class="<header>" data-code-block-banner>
        <div class="<heading>"><span class="<language>">html</span>…</div>
        <div class="<actions>">[wrap][copy]</div>
    <div class="<content>" data-code-block-content>
      <div class="shiki"><pre class="shiki css-variables">…</pre></div>     ← 已高亮

无 toolbarLabels
  <div class="<banner>" data-code-block-banner>
    <div class="infostring">{lang}</div>        ← 裸文本节点，没有 span
    <div class="<actions>">[copy]</div>         ← 只有一个按钮
```

`readLang`（`dom-seam.js:131-138`）取 `banner.firstElementChild.firstElementChild`
的 `textContent`。在第二个分支里这两层是 `infostring` 的 `<div>` 与其文本节点，
`firstElementChild` 为 `null`，于是返回 `''` —— 块退化成「无语言 + 内容嗅探」，
而**不是**被跳过。

**语言名没有 `data-lang` 之类的后备属性**，它只作为 banner 里的文本存在。

### 2.3 content 节点不生成盒子

`CodeBlock.module.css:72-76`：

```css
/* Consumers may turn the stable content node into a viewport without changing
   the default CodeBlock layout. */
.content {
  display: contents;
}
```

`display: contents` 意味着该节点**没有自己的盒子**，三条后果本插件都依赖：

1. 块的高度**等于**当前可见子节点的高度，没有独立的容器高度；
2. 写在 content 节点上的 `>` 子选择器仍然匹配它的子节点 —— 视图切换靠这个；
3. DSH 自己的代码视图也不设高度（`.block :where(pre)` 只有 `padding` 与
   `overflow-x: auto`），所以固定高度的预览会与它替换的视图语义不一致 ——
   这是**测量**而不是估算的理由。

### 2.4 稳定态与流式态的形态差异

内容节点的 `firstElementChild`：

| 形态 | 含义 |
|---|---|
| `<div class="shiki">` | 已高亮，围栏闭合 |
| `<pre class="shiki">` | 可能是流式中，**也可能**是宿主不高亮的稳定态 |

判据只读 `child.tagName === 'DIV'`（`dom-seam.js:100`），不参与类名。
第二种形态是二义的，`settleState` 只报告形状，由调用方结合 banner 标签消歧。

### 2.5 会话边界

轨迹标签页也渲染 `.md-code-block`，但它的 bundle 不带任何 `data-chat-*` 属性，
会话区带约 60 个。边界因此建在**祖先选择器**上
（`dom-seam.js:61`，该常量在本文件内，不在 `dom-contract.js`）：

```
[data-chat-flow],[data-chat-node-key],[data-chat-turn],[data-chat-group-key]
```

取并集而非单一属性：嵌套层次是 DSH 的事，`data-chat-flow` 在流容器上、
`data-chat-node-key` 在每条消息行上，块可能在其中任一之下。选一个会在布局调整
那天静默丢块。

### 2.6 模块系统与 on-demand chunk

四条契约，全部由 `tools/probe-host.mjs` 核：

1. chunk 文件名匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`，且与入口同目录；
2. 不带内容 hash —— chunk 的 id 是 `<包名>/<文件名>`，带 hash 就自指循环；
   请求 URL 带入口的 `?rev=`，重建必然换 URL；
3. 入口必须用 `require.async('./client.x.js')`，不能用 `import()` ——
   CJS 下 `import()` 编译成普通 `require`，会抛 `missed the module table`；
4. 每个产物需要各自的 `__ModuleLoader__.load({ id })`，所以 `banner` 必须是
   以 chunk 名为参数的**函数**。

因此引擎声明为**第二个 entry**而非代码分割产物：第 3 条的请求是一个没有
import 表达式支撑的字符串，打包器看不见它。

产物内**会**出现 `require` 调用，就是这条 chunk 请求
（`require.async`），其余基线模块一次都不取。

### 2.7 客户端 `ctx`

cordis 的 `Context` 是 proxy，**读未注册成员直接抛**；抛在 `apply` 里等于
web boot 失败，而 DSH 把这种失败当致命启动错误（boot 审计只报
`<name>: failed`，栈只进浏览器控制台）。

`tests/ctx-harness.mjs` 暴露 `get` / `effect` / `on` / `provide` 四个成员，
读别的即抛。它**比真实客户端 context 更窄**（后者混入 16 个成员，
cordis `reflect.ts:219-222`）——加宽 harness 等于删掉那道守卫。
本插件实际只用到 `get` 与 `effect`；允许清单只在 `AGENTS.md` §5.5。

`document` / `console` / `MutationObserver` 是浏览器全局，不在 `ctx` 上。
样式表自己插 `<style data-plugin="dsh-viewer-kit">` 并在 disposer 里移除。

翻译字典的注册**不由 `ctx.effect` 持有**，理由见
[03-pitfalls.md](03-pitfalls.md) §6。

---

## 3. 配置契约

### 3.1 单一来源

`src/schema.js` 的一张字段表同时派生出三样东西：

- 宿主半体导出的 `Config`（Standard Schema v1，**零依赖手写** —— 宿主半体是
  原样拷贝、没有打包器，schema 库得在运行时从 profile 解析）；
- 客户端的 `DEFAULT_CONFIG` 与宽松回落 `resolveConfig`；
- `cordis.patch.yml` 里的配置文档。

字段表还导出 `DEFAULT_PROTOTYPE_STYLE`（27 行 / 986 字符），它是
`prototypeStyle` 这个键的**默认值**，不是对它的第二份描述。

### 3.2 两侧严格程度故意不同

| | 宿主半体 | 客户端半体 |
|---|---|---|
| 值不对 | **响亮失败** | 静默回落默认值 |
| 不认识的键 | **报错** | 忽略 |
| 理由 | 配置写错本该立刻发现；宿主半体无行为，失败只记日志 | 路由 404、宿主半体没装、两版本不一致 —— 能渲染比什么都看不到重要 |

### 3.3 通道与持有形态

boot 线缆不带配置（§2.1），所以宿主把结果发布在一条只读 HTTP 路由上，
浏览器在首次扫描前取一次：

```
cordis.patch.yml ─▶ apply(ctx, config) ─▶ Config schema 校验
                                             │ 失败：响亮报错
                                             ▼ 通过
                                     GET /dsh-viewer-kit/config   （cache-control: no-store）
                                             │
                        浏览器 apply() ──────┘  1200ms 超时，之后回落默认值
```

**接缝整体推迟到配置落地之后**：`createDomSeam` 在**构造时**就挂上
MutationObserver（`dom-seam.js:460`），所以推迟的不是一个 `scan()` 调用，
是整个接缝。首屏因此就是最终结果。

配置在两侧各存一份，两份都不自己更新：

| | 持有者 | 位置 | 更新的时机 |
|---|---|---|---|
| 宿主 | `resolveConfig` 算一次，闭包捕获 | `src/index.js:94` | 宿主半体重新激活 |
| 浏览器 | 每次页面加载 fetch 一次 | `src/client/index.js:217` | 整页重新加载 |

**配置文件本身只在 boot 路径上被读**（`dsh-app-boot` 的 `loadProfile` /
`loadOptionalPatches`），`dsh-app-boot` 与 `dsh-cordis-host-runner` 里没有针对它的
文件监听。唯一写它的地方是 `ConfigEditor.edit()`（`dsh-config-editor/lib/index.js:69`），
而它**写完会自己调 `reconcileProfilePatches`**（`:125`），把变化推给 Loader：

```
设置界面 ─▶ settings.mutate(...)            dsh-client-ui-settings/lib/client.js:1182
             ▶ configEditor.edit(entry, …)   dsh-settings/lib/index.js:508
             ▶ 原子写回 patch 文件           dsh-config-editor/lib/index.js:123
             ▶ reconcileProfilePatches(...)  :125
             ▶ Entry.update() → fiber.update() → apply(ctx, 新 config)   同进程重跑
```

也就是说**宿主侧的热更通道是通的**，而本插件目前走不到它：`dsh-settings` 的
`describe()` 用 `volatileForm(schema)` 收集表单，取不到就整条跳过该插件
（`dsh-settings/lib/index.js:418-419`），`write()` 对没有 volatile 字段的条目
直接抛 `has no volatile fields`（`:505-506`）。本插件的 `Config` 没有声明任何
`.volatile()`，所以**改配置文件需要重启 profile**。

DSH 补上这条声明之后，本插件这边还有两处要跟上：宿主在**请求时**解析而不是
apply 时（`src/index.js`），以及客户端在窗口重新获得焦点时重取一次
（`src/client/index.js`）。后者**不能**做成"随时重取并逐块重协商" ——
改块高度正是 §6 那条滚动不变量要抵消的位移来源，页面级的一次性重建才是安全形态。

---

## 4. 核心契约（L4）

`contract.js` / `kit.js` / `view-state.js` 三个文件不引用 `document`，
所以协商、指纹、视图状态全部可在纯 Node 下测。

### 4.1 RenderRequest

```ts
{
  id: string           // 指纹：fingerprint({ scope, lang, source })
  surface: 'code-block' | 'tool-call' | 'document'
  lang: string
  source: string
  meta?: { info?: string }
}
```

**`createRequest` 不做归一化**（`contract.js:250`，`input.lang ?? ''`）。
`lang` 的归一化由调用方在传入前完成（`code-block-surface.js:105` 调
`normalizeLang`）。归一化规则必须与宿主一致，否则 ```html title="x" 会
认领出 `html title="x"` 而匹配不到任何东西：

```
取 /^[\w-]+/ 去掉 info 串 → 转小写 → 折叠别名
htm|xhtml → html    chart → echarts    tsv → csv
```

### 4.2 指纹

```
key = `${scope}\0${lang}\0${source}`
id  = `${fnv1a(key,0).toString(36)}.${fnv1a(key,0x9e3779b9).toString(36)}.${key.length.toString(36)}`
```

`scope` 取最近的 `[data-chat-node-key]` 祖先（`dom-seam.js:79-82`）：
同一条消息里重复的同一段代码共享视图选择，不同消息里的互不影响。
碰撞最多导致两段不同的代码共用一个**视图选择**，不会导致内容渲染错误。

### 4.3 Renderer

```ts
interface Renderer {
  id: string
  label?: string
  priority?: number          // 默认 0，越大越优先
  match(request: RenderRequest): boolean
  create(host: RenderHost): RendererInstance | null
}
```

`match` 与 `create` 分开：前者是纯判定、可缓存、可重复调用；
后者有副作用且必须可失败。

`RenderHost` 交给渲染器的东西很窄：建节点、挂载、清空容器、读尺寸上限、
上报致命错误、读配置。**`config()` 返回的是 Kit 内部的活对象**
（`kit.js:205`，未冻结未拷贝）；真正返回冻结快照的是 `kit.config()`（`:248`）。

`viewsOf`（`kit.js:152-158`）把渲染器自己的视图里 id 为 `'code'` 的滤掉，
再补上宿主自己的 `CODE_VIEW`；渲染器一个视图都不给时，标签退化为 `'source'`。
所以渲染器只需要实现增强视图，**`'code'` 是零成本**的：切回代码只是把模式属性
改回去并清空自有容器，原生 `<pre>` 原封不动地重新露出来。

### 4.4 协商算法

`negotiate`（`kit.js:111-143`）的五步，顺序有意义：

```
1. !config.enabled                                   → null（总开关）
2. disabledRendererIds.includes(request.lang)        → null（围栏名档，在任何 match 之前）
3. 查 negotiationCache[request.id]
4. 遍历 sorted()：
     disabledRendererIds.includes(renderer.id)       → continue（渲染器 id 档）
     renderer.match(request) 抛错                    → onError + continue（不炸接缝）
     第一个 === true 的即胜出
5. 写入缓存
```

`sorted()` 是 `priority` 降序、`id` 升序。按 `id` 而不是注册顺序决胜，
是为了让结果与 DSH 加载社区插件的顺序无关。

两个禁用档的语义不同：围栏名档是**整块否决**（该块不进入任何渲染器），
渲染器 id 档是**跳过该渲染器**，块重新交给剩下的渲染器。

胜出者 `create` 失败时**不回退到次优渲染器** —— 静默换一个会让用户困惑，
明确的不渲染更可预测。

**`defaultView()` 是 Kit 级的**（`kit.js:164-166`，返回 `'preview'` 或 `'code'`），
与渲染器无关。渲染器若不认 `'preview'`，`pickInitialView` 会退到 `views[0].id`。

### 4.5 视图状态

```
key   = RenderRequest.id（内容指纹）
value = 'code' | 渲染器自定义 viewId
```

按内容而不是按 DOM 元素：React 会重建这些节点，按元素存必然每次重渲染都丢。

持久化用 `sessionStorage`，键 `dsh-viewer-kit:views:v1`；读取走内存镜像，
只在写入和首次读取时碰 storage。**不可用时静默降级为纯内存**（`safeStorage`
会实际写一个探针键，因为隐私窗口和内嵌 webview 暴露对象却仍会在写时抛）。
存储损坏或写满都只丢跨刷新的记忆，不影响渲染。

**只有用户主动点的视图才被记住**（`code-block-surface.js:311` 的 `byUser`）。
首次打开的视图由 `defaultToPreview` 推导，把它记下来会让那个设置在第一次
使用后就被冻结。

`kit.subscribe` **不随视图变化触发** —— 它只在 `invalidate()` 时被叫，
而 `invalidate()` 由 `register` / 注销 / `setConfig` 触发。视图变化的事件发到
`view-state` 自己的 listener 集（`view-state.js:94-96`），Kit 不转发。

---

## 5. 接缝（L1 + L3）

`dom-seam.js` 与 `code-block-surface.js` 是**仅有的两个**碰 DSH DOM 的文件。

### 5.1 发现与回收

一个 `MutationObserver`（`childList + subtree`，观察 `doc.body`）加一次全量扫描：

| 情况 | 处理 |
|---|---|
| 新块出现（含新增节点里的嵌套块） | `evaluate` |
| React 换掉了 banner 子树 | `childList` 记录的 target 向上找块再 `evaluate` |
| 块被移除 | `dispose`，从索引里删除 |

索引 `surfaces` 是 `WeakMap<Element, { dispose, bytes }>`。
`quietTimers` / `retryCounts` / `arrivals` 是三个**强引用** `Map`，
`dispose()` 会清空它们。

### 5.2 已认领块的再评估

`surfaces.has(element)` 时（`dom-seam.js:299-322`），认领只在**两个条件同时成立**
时保留：

```
ownsInjection(element)            ← 我们注入的开关节点还在
readSource(content).length === claimed.bytes   ← 源码还是认领时那一份
```

任一不成立就 dispose 重来。第一条挡的是 React 重建了 banner 子树（我们的节点
跟着走了，而那个 mutation 正好回调到这里）；第二条挡的是**认领之后流又恢复了** ——
预览一份被截断的文档和开关消失是同一种静默。

### 5.3 认领门

`evaluate` 的判断顺序（`dom-seam.js:297-368`）：

```
disposed                                  → 直接返回
surfaces.has(element)                     → 见 §5.2
!inConversation(element)                  → 返回，**不排重试**
content === null                          → schedule
source.trim() === ''                      → schedule

generic = isGenericLabel(label)
!generic && settleState(content).reason !== 'highlighted' && !hasSettled(…)
                                          → schedule
否则                                       → 认领
```

三支的分工：

**① 通用标签** —— banner 显示的是本地化兜底文案，说明宿主对这个围栏没有高亮器，
**`<div class="shiki">` 外壳永远不会出现**，等它会等到重试预算耗尽。
这类块**当场认领**，`lang` 置空交给渲染器按内容判断。判断依据只有
`GENERIC_LABELS`（`dom-seam.js:29-41`，中英文各若干），不看内容。

**② 高亮态** —— 形态差异本身就是信号，围栏闭合时那次子元素替换是可见的
`childList` 变更。

**③ 真标签 + plain 正文** —— 宿主给了一个它不打算高亮的语言名，形态永不改变。
只有这一支等 `hasSettled`。

`hasSettled`（`dom-seam.js:259-273`）：

```
bytes = source.length                      （UTF-16 code unit，不是字节）
未见过 或 长度变了                         → arrivals.set(...); retryCounts.delete(); false
now - seen.since < SETTLE_QUIET_MS         → false        （= PLAIN_SETTLE_MS * 2 = 600ms）
否则                                        → arrivals.delete(); true
```

**两个静默窗口而不是一个**：一次观察无法区分"围栏闭合"与"模型停下来想"，
而误判成闭合会挂载一份半截文档的预览。两个连续不变才把"没有变化"变成决定。

**为什么按内容而不是按形态**：形态这个代理在两个方向上都会错 —— 流式中与
高亮语言围栏的稳定态同形，而宿主永不高亮的围栏会一直停在 `<pre>` 上，
等形态就等于等到预算耗尽。内容不会：还在到达的围栏每个 token 都变长。

### 5.4 重试预算

`schedule`（`dom-seam.js:408-422`）在 `PLAIN_SETTLE_MS`（300ms）后重跑
`evaluate`，次数上限 `MAX_QUIET_RETRIES`（100，约 30s）。同一个元素已有定时器时
不重复排。

它是**兜底**而不是主信号 —— 围栏闭合是 MutationObserver 直接看见的
`childList` 变更。定时器只防"某次变更在节点拿到最终形态之前就到了"。

它同时是这些路径的定时器：无渲染器认领、超限、单视图、`create` 返回 null、
content 节点缺失、源码为空。

`hasSettled` 每次观察到长度变化就 `retryCounts.delete(element)`
（`:267`），所以**持续增长的块不会耗尽预算**。

### 5.5 对宿主 DOM 的写操作

`code-block-surface.js` 在一个块里只做这些事：

1. **只追加带 `data-dvk-*` 标记的自有节点**，不删除、不移动、不改写任何 DSH 创建的节点；
2. **可见性用样式**：切换视图只改 content 节点上我们自己的 `data-dvk-mode`，
   由自有样式表决定谁可见。React 不会清除它没设置过的属性；
3. **两个节点都追加到 `banner.lastElementChild`**（尾部操作组）：视图开关
   `[data-dvk-switch]` 与放大按钮 `[data-dvk-action="expand"]`。后者是开关的
   **兄弟**而不是子节点，所以移除开关带不走它；
4. **不碰 `<pre>` 的 innerHTML**，切回代码零失真；
5. **注入前先清残留**（`:168-169`）：扫掉块里的 `[data-dvk-switch]` 与
   content 里的 `[data-dvk-root]`。HMR 重新启用、或 React 重建节点时保留了我们
   的子节点，都会让第二次注入叠出第二个开关；
6. **`dispose()` 只删自己加的**：`viewRoot` / `switcher` / `expandControl`
   与 content 上的 `data-dvk-mode`；
7. **唯一一处祖先写操作**是滚动补偿（§6），由 `scroll-guard.js` 完成。

`banner.lastElementChild` 假定它是操作组，代码**不校验**。

### 5.6 降级矩阵

| 情况 | 行为 | 用户可见提示 |
|---|---|---|
| 不在会话容器内 | 静默跳过，**不排重试** | 无 |
| content 节点缺失 | 重试至预算耗尽 | 无 |
| 源码为空白 | 重试至预算耗尽 | 无 |
| 通用标签或高亮态 | 认领 | 开关 |
| 真标签 + 未静默 | 重试至预算耗尽 | 无 |
| `enabled: false` | 协商返回 null | 无 |
| 围栏名在 `disabledRendererIds` 里 | 整块否决 | 无 |
| 超 `maxSourceBytes` | 认领后 `withinLimits` 为假 → 返回 null | 无 |
| 无渲染器认领 | 返回 null | 无 |
| `create` 返回 null 或抛错 | 返回 null | `console.error` |
| 只有 `code` 一个视图 | dispose 实例，返回 null | 无 |
| `banner.lastElementChild` 为 null | dispose 实例，返回 null | 无 |
| 宿主无 `MutationObserver` | 接缝整体返回全套 noop | `console.error`（一次） |

除两条 `console.error` 外，**所有降级都不产生任何用户可见文字**。

---

## 6. 滚动补偿

认领一个块必然改变它的高度：内容节点是 `display: contents`（§2.3），
所以块高**等于**可见子节点的高度，认领把"和源码一样高的 `<pre>`"换成封顶的视图。

三个本该兜底的机制恰好都不工作（三条宿主事实记在 `dom-contract.js` 的
"The conversation's scroll model"，升级时只核对那里）：

- 会话是**虚拟列表**（TanStack Virtual，`overscan: 3`），一个块经常在读者
  **上方好几屏**的位置被认领；
- 浏览器的 **scroll anchoring** 在滚动手势进行中被抑制，而接缝是在
  `MutationObserver` 回调里认领的，也就是在滚动当中；
- 虚拟列表自己的补偿在 `scrollDirection === "backward"` 时**故意不修正** ——
  往上滚时修正会跟读者自己的滚动打架。

`keepingScrollPosition(node, change)`（`scroll-guard.js:127-168`）：

```
scroller = 向上找 clientHeight > 0 && scrollHeight > clientHeight 的祖先
           （用几何而非计算样式 —— 不能滚的祖先无论 overflow 写什么都忽略 scrollTop）
无 scroller / 无布局               → change()
before.bottom >= 中线              → change()      ← 判据
scroller.closest('[data-chat-following-tail]') → change()   ← 必须在 change() 之前读
result = change()
delta = after.height - before.height
scroller.scrollTop = clamp(0, scrollHeight - clientHeight, offset + delta)
```

**判据是视口中线**（`:139`）：`before.bottom < viewport.top + viewport.height / 2`
才补。块的高度变化只移动它**下方**的内容，所以唯一要问的是读者在读的是不是那部分。

中线由 `bandOf` 的 `bottom`（`top + height`）推出而不是读 `rect.bottom`，
这样"在不在屏上"和"有多高"不会来自两个可能不一致的数。

`FOLLOWING_TAIL` 必须在 `change()` 之前读，且问宿主而不算距离：高度一收缩文档
就短了，事后拿旧 offset 比新 `scrollHeight` 会把每个读者都判成越界，而越界
恰恰是唯一必须补偿的那种情况。宿主跟随流式时会自己从总高度重新推导 offset，
再补一次就是同一次变化让读者被挪两次。

补偿路径上共 **3 次** `getBoundingClientRect`（`:132` `:133` `:150`），
外加 `scrollTop` / `scrollHeight` / `clientHeight` 三次布局读。它包住
**整次视图切换**（`code-block-surface.js:322`）而不是切换里的每一次 DOM 写。

---

## 7. 安全模型

模型产出的 HTML 是**不可信输入**。预览一律走 `<iframe sandbox>`，
`referrerpolicy="no-referrer"`。

### 7.1 sandbox 取值随模式而变

| `previewHeightMode` | `sandbox` | 决定于 |
|---|---|---|
| `measure`（**默认**） | `allow-scripts` | **无条件** —— 测量脚本就是文档本身，它自报内容高度（`html.js:304`） |
| `fit` / `fixed` | `htmlAllowScripts ? 'allow-scripts' : ''` | 只有 `htmlAllowScripts`（`html.js:316`） |

**任何配置下都不同时给 `allow-scripts` 与 `allow-same-origin`**，所以文档始终是
不透明源，读不到宿主的 DOM / cookie / storage。

### 7.2 默认路径上挡住模型脚本的是 CSP，不是 sandbox

`measure` 模式下 sandbox 已经给了脚本权限，模型脚本由注入的 CSP 挡着
（`buildMeasuredDocument`）：

```html
<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-<uuid>'">
```

nonce 由 `crypto.randomUUID()` 现场生成，只有测量脚本带它。
`htmlAllowScripts: true` 时整条 CSP 被移除（`policy = allowScripts ? '' : …`），
模型的脚本才会运行。默认是 `false`。

### 7.3 其余措施

- 表格视图用 DOM API 建节点，**不解析模型产出的标记**；
- 表格行数列数有上限（500 行 × 40 列，单元格 400 字），超出截断；
- **不提供"在新标签页打开"** —— 用 `blob:` URL 打开会以宿主同源执行，
  绕开 iframe 提供的全部保证（[03-pitfalls.md](03-pitfalls.md) 末节）；
- 已知的残留风险：**渲染一段内容就可以发起该内容的网络请求**，这一条在所有
  配置下都成立，因为浏览器必须加载子资源才能排版。

---

## 8. 宿主半体

### 8.1 配置路由

`src/index.js` 在 `apply` 里 `resolveConfig` 一次，然后注册一条
`GET /dsh-viewer-kit/config`，`cache-control: no-store`。
注册包在 `ctx.effect` 里 —— `webServer.register` 对同一 `(kind, path)` 直接抛，
而 `effect` 立刻执行回调并把返回值当 disposer，路由因此在停用时被摘掉。

### 8.2 原型模式

`apply_prototype_style` 工具翻转一个 `armed` 标志；`systemPrompt.section()` 的
`text` 每次组装请求前执行：

```js
text: () => {
  if (!armed) return ''      // 组装器丢弃空段落 —— 未武装时零 token
  armed = false              // 在返回的路上清掉，不是之后清
  return spec
}
```

状态归段落自己管，**关闭这件事不存在于模型的动词表里**，也就没有忘记关的可能。
工具描述里明确告诉模型到期自动失效，否则模型会自己发明一个退出工具。

`order: 50` 落在宿主的 `DEPLOYMENT_PERSONA_PREFIX`（0）与 `PLAN_POLICY`（500）
之间、工具引导（从 `TOOL_BASH: 1000` 起）之前，由一条测试守住 `0 < order < 500`。
**这三个宿主常量没有任何探针覆盖**，DSH 往 `0..500` 塞新段落时需要重新核对。

工具不实现 `isConcurrencySafe`，即声明为独占：它翻转的状态由紧接着的那次组装
读取，两次调用不能交错。

`prototypeStyle` 的默认是 `''` 而不是那 27 行规范，空串表示"用内置的"，
这样解析后的配置保持一个短标量 —— 它会原样发上配置路由，也会被打印在一行
启动日志上。它会随配置发到浏览器，但没有任何渲染器读它。

---

## 9. 验证手段

| 层 | 手段 |
|---|---|
| L4 内核 | 纯 Node 单测，无 DOM 依赖 |
| L1 / L3 | 从 DSH 发行包抄下来的真实 DOM 片段做夹具，跑在 `tests/dom-shim.mjs` 上 |
| L5 | 每个渲染器自带夹具与断言 |
| 构建产物 | `pnpm run repro` 把 `client/client.js` 塞进一个假的 `__ModuleLoader__` 里真跑一遍 |
| 宿主契约 | `pnpm run probe` 读本机 `app.asar`，核 8 组假设 |
| 探针自身 | `pnpm run probe:test` —— 每条检查都有一个"改坏的宿主"能让它变红，外加一条"忠实宿主必须全绿" |

`pnpm run check` = typecheck + build + test + repro + probe:test + probe。

**覆盖范围**：文档守卫只扫 `README.md` 与 `AGENTS.md`。`docs/` 不在扫描范围内，
所以本文的行号与语义断言没有任何自动核对 —— 升级 DSH 或改动源码后，
本文需要人工回校。探针找不到 DSH 时 SKIP 而非通过，输出里不会出现
`assumptions confirmed`。
