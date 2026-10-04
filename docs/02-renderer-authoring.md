# 写一个新的渲染器

> 这份文档面向"以后要往 kit 里加东西"的你。
> 读完之后你应该能只新建 **一个文件**、加 **一行注册**，就得到一个新渲染器，
> 而不需要读 `kit.js`、`dom-seam.js` 或 `code-block-surface.js`。

> 这不是承诺，是已经发生过的事：`renderers/table.js` 是在 `html.js` 之后
> 单独加进去的，当时内核与接缝一行都没改，也没有多写一个 DOM 夹具。

> 改代码前先看 [AGENTS.md](../AGENTS.md) —— 房子规矩（尤其是 §4.1 注释怎么写）
> 在那里。架构取舍见 [01-architecture.md](01-architecture.md)。

> **但有一个前提，先说清楚：以上只对"自包含"渲染器成立。**
> `renderers/echarts.js` 是第二个真实交付物，它需要**四处**改动（引擎 chunk、
> 构建配置、可能还有 L1 的识别判据）。两档的完整对照见
> [`docs/01-architecture.md` §4.6](01-architecture.md#46-两档渲染器这条主张的边界实测修正)。
>
> 先回答"我要不要引入一个引擎库"：
>
> | | 自包含 | 带引擎 |
> |---|---|---|
> | 例子 | `table`（自己解析 CSV/JSON） | `echarts`（1.4 MB 引擎） |
> | 改动 | 本文件 + 1 行注册 | 本文件 + `chunks/` + `tsdown.config.ts` + 可能改 L1 |
> | 包体 | 几 KB | 引擎独立成 chunk，按需 fetch |
> | 围栏识别 | 语言名可靠（`csv`/`json`/`markdown` 都在 Shiki 表里） | **可能拿不到语言名，见第 3 节** |

---

## 0. 你需要改动的全部（自包含渲染器）

```
src/client/renderers/<你的渲染器>.js     ← 新建，就这一个文件
src/client/index.js 的 RENDERER_FACTORIES ← 加一行
```

没了。没有新的 slot、没有新的 DOM 选择器、没有新的测试夹具。

（可选：实例上返回一个 `expand` 就能拿到放大控件，见 §8.5；它**不**要求改动上面任何一个文件。）

`src/client/renderers/table.js` 就是这么来的——它是在 `html.js` 之后单独加进去的，
当时 `kit.js` / `dom-seam.js` / `code-block-surface.js` / `contract.js` **一行都没动**。
`tests/run.mjs` 里 "second renderer" 那一节就是用来钉住这个性质的。

---

## 1. 最小可用模板

```js
// src/client/renderers/mermaid.js

/**
 * @param {(key: string, fallback: string) => string} t
 * @returns {import('../contract.js').Renderer}
 */
export function createMermaidRenderer(t) {
  return {
    // 全局唯一，也是优先级相同时的确定性排序键
    id: 'mermaid',
    label: 'Mermaid',
    priority: 5,                       // 默认 0；越大越优先

    // 认领判定：必须便宜、无副作用
    match(request) {
      return request.lang === 'mermaid'
    },

    // 创建实例；返回 null 表示"这块不渲染"（外壳会保持原生外观）
    create(host) {
      const { request, document: doc, mount } = host

      return {
        // 本渲染器提供的视图。宿主会自动补上永远可用的 'code' 视图，
        // 所以你只需要实现"增强视图"。
        views: [{ id: 'preview', label: t('view.preview', 'Preview') }],

        enter(viewId) {
          // 'code' 视图由宿主处理，你的 enter 不会被它调用到有意义的程度，
          // 但为了对称，实现它是好习惯。
          if (viewId === 'code') return
          const node = doc.createElement('div')
          node.className = 'dvk-mermaid'
          mount(node)
          // …异步加载库、绘制，结束后往 node 里塞内容
        },

        // 宿主离开这个 surface 时调用。释放定时器、观察器、子组件。
        dispose() {},
      }
    },
  }
}
```

注册：

```js
// src/client/index.js
const RENDERER_FACTORIES = [createHtmlRenderer, createTableRenderer, createMermaidRenderer]
```

---

## 2. `RenderRequest`：你看到的是什么

```ts
{
  id: string           // 内容指纹，视图状态按它记账
  surface: 'code-block' // 目前只有这一种；将来会有 'tool-call' / 'document'
  lang: string         // 已归一化：小写、别名折叠、剥掉 fence 的 info 串
  source: string       // 原始文本，未裁剪未转义
  meta?: { info?: string }
}
```

### 2.1 `lang` 可能是空串，而这不是错误

**这是本 kit 最容易踩的坑，值得单独一节。**

DSH 的 `CodeToolbar` 渲染 `supportsHighlighting(lang) ? lang : <fallback>`，
`supportsHighlighting` 查的是 Shiki 内置的 `LANG_ALIASES`——**不支持自定义围栏语言**。
后果：

```
```csv       → Shiki 认识 → banner 显示 "csv"      → lang = 'csv'
```markdown  → Shiki 认识 → banner 显示 "markdown" → lang = 'markdown'
```echarts   → Shiki 不认识 → banner 显示 "代码块"  → lang = ''
```

围栏的真实名字**在 DOM 里根本不存在**，也没有 `data-lang` 之类的后备属性。
所以 `lang` 为 `''` 有两种可能：围栏本来就没写语言，或者写了但 DSH 不认识。

**你的 `match` 必须能处理这种情况**，否则模型写什么围栏名都白搭：

```js
match(request) {
  if (MY_LANGUAGES.has(request.lang)) return true   // ① 语言名可靠时，照旧
  return looksLikeMyContent(request.source)         // ② 否则看内容
}
```

流式安全也是靠内容而不是定时器：**流式中的内容解析不了，判据自然不通过**，
等补全的那次 mutation 到达就认领。不要靠"等一会儿"来区分。

`renderers/echarts.js` 的判据是"能 `JSON.parse` 成**非数组对象**且含**非空 `series` 数组**"。
判据要**够特异**：太松会把别人的代码块抢过来，太紧则形同虚设。

> `table` 之所以没暴露这个问题，纯属运气——它认领的 `csv` / `json` / `markdown`
> 恰好都在 Shiki 表里。**下一个渲染器不一定会这么走运。**

`lang` 的归一化规则（`contract.js` 的 `normalizeLang`）与 DSH 自己的取值方式一致：
取 fence 串开头的 `/^[\w-]+/`，转小写，然后折叠别名（`htm`→`html`、`chart`→`echarts`、
`tsv`→`csv`）。所以 ```` ```HTML title="x" ```` 拿到的 `lang` 就是 `html`。

`match()` 里想用"原始语言名"就用 `rawLang(request.lang)` 的同类信息——
不过实际上你几乎总是想要归一化后的 `request.lang`。

---

## 3. `RenderHost`：你能做什么

```ts
{
  request,                      // 上面那个对象
  document,                     // 建节点用
  mount(node),                  // 挂到 surface 自己的容器里
  clearView(),                  // 清空该容器（切换视图时宿主已经替你调过）
  limits: { maxSourceBytes, maxPreviewHeight, maxTableHeight },
  fail(error),                  // 上报致命错误：外壳降级为原生代码块
  config(),                     // 只读配置快照
}
```

### 3.1 `code` 视图是免费的

宿主保证 `'code'` 视图永远存在，并且**不经过你的 `enter` 去做任何实际工作**：
切回代码时，宿主把 `[data-code-block-content]` 上的模式属性改回去，
你挂载的东西被移除，**原生 `<pre>` 原封不动地重新露出来**。

所以：

- 你只需要实现增强视图；
- 不要试图"缓存一份代码再自己重绘"——那样必然和 DSH 的高亮结果有细微差异；
- 不要在 `dispose()` 之外的地方清理 DOM。

### 3.2 每次切换视图，`viewRoot` 都是空的

```js
enter(viewId) {
  // 这里的 host 容器已经保证是空的，直接建节点挂上去即可
}
```

这是刻意的：它让"从预览切回预览"这类场景不需要渲染器自己管理清理。

---

## 4. 优先级与竞争

```
候选 = 所有 renderer 里 match(request) 为 true 的
胜出 = 候选按 (priority 降序, id 升序) 的第一个
```

`id` 升序是为了**让结果与插件加载顺序无关**。DSH 加载社区插件的顺序是不确定的，
如果按注册顺序决胜，同一份内容在不同机器上可能被不同渲染器接管。

实测例子（`tests/run.mjs`）：

```js
const a = createKit(); a.register(r('aaa', 0, always)); a.register(r('bbb', 0, always))
const b = createKit(); b.register(r('bbb', 0, always)); b.register(r('aaa', 0, always))
// a.negotiate(req).id === b.negotiate(req).id === 'aaa'
```

如果你要接管别人已经认领的语言，把 `priority` 调高。
如果两个渲染器都可能认领同一段内容、且你希望共存——**目前不支持**。
一个 surface 只有一个胜出者，这是刻意的简单；需要多视图共存时，正确做法是
一个渲染器在 `views` 里给出多个视图，而不是注册两个渲染器。

---

## 5. 失败处理

`create()` 里抛异常、或 `match()` 里抛异常，都不会拖垮整个插件：

| 抛在哪 | 结果 |
|---|---|
| `match()` | 记一次日志，**跳过这个渲染器**，继续看下一个候选 |
| `create()` | 记一次日志，这块内容保持原生代码块，**不加开关** |
| `enter()` | 记一次日志，surface 仍在，只是这次切换没生效 |

宿主**不会**在胜出者失败时自动回退到次优渲染器——静默换一个渲染器会让用户困惑
（"我明明装了两个，为什么显示的是另一个"）。明确的"不渲染"更可预测。

如果你希望失败时尝试下一个渲染器，在自己的 `match()` 里表达即可：

```js
match(request) {
  if (request.lang !== 'mine') return false
  return canHandle(request.source)   // 提前判断，别让 create 变成 try/catch
}
```

---

## 6. 内容嗅探：比语言更细的认领

`match()` 拿到完整 `source`，所以可以按内容判断。这是"数据表格"渲染器的做法：

```js
match(request) {
  if (request.lang === 'json') return readTable('json', request.source) !== null
  return false
}
```

代价：`match()` 会对**每一段被扫描的代码块**调用，所以它必须便宜。
`readTable` 里先 `JSON.parse` 再校验形状，对几十 KB 的内容是可接受的；
但不要在这里做正则回溯灾难或者网络请求。

`kit.js` 会按 `request.id`（内容指纹）缓存协商结果，同一段内容只跑一次 `match`。

---

## 7. 安全：什么时候需要沙箱

| 你要渲染的东西 | 需要沙箱吗 |
|---|---|
| 你自己用 DOM API 建的节点（表格、树、列表） | **不需要**。没有解释任何标记 |
| 第三方库画的 canvas / SVG 图表 | **不需要**，但要确认该库不注入 `<script>` |
| 模型的原始文本（HTML / SVG） | **必须**。照 `renderers/html.js` 抄：`sandbox` + `referrerpolicy` |

沙箱的三条铁律（`docs/01-architecture.md` §8）：

1. `allow-same-origin` 和 `allow-scripts` **永远不能同时出现**；
2. 默认 `sandbox=""`，脚本要显式开配置项；
3. **不要**提供"在新标签页打开"——用 `blob:` URL 打开会以宿主同源执行，
   等于把 iframe 提供的全部保证一次性绕掉。

---

## 8. 视图标签与文案

`views[].label` 只是诊断用的默认文案。用户看到的是 `t(\`view.<id>\`, fallback)`：

- 在 `locale.js` 的 `DICTIONARIES.en` / `.zh` 里加 `view.<你的 id>`；
- 渲染器里写 `t('view.mermaid', 'Mermaid')`；
- 宿主没有 locale 服务时，`locale.js` 会按 `document.documentElement.lang`
  回退到内置字典，所以不接 locale 也不会显示原始 key。

> 字典两个语言必须**键集合相同**，测试会断言。加了新键只加一边，
> 那个语言就会静默回落英文 —— 而且**不报错**。`tests/run.mjs` 里有一条直接比对两边的用例。

---

## 8.5 放大控件（可选契约）

实例上多返回一个 `expand`，宿主就会在 banner 上放一个放大图标。
**不返回就没有控件** —— 一个不实现任何东西的渲染器不该长一个按了没反应的按钮。

```js
return {
  views: [...],
  enter(viewId) {},
  dispose() {},

  expand: {
    toggle() { /* 开 / 关 */ },
    isOn: () => /* 现在开着吗 */ },
  },
}
```

**四个成员各自对应一个具体问题：**

| 成员 | 什么时候需要 |
|---|---|
| `toggle` / `isOn` | 总是 |
| `subscribe` | **弹窗型必须有**。`showModal()` 让整页 inert，控件开着时按钮**按不到第二次**，读者用 ESC 或点背景离开。没有通知，按钮报告的状态会永久停在"已展开"。 |
| `available` | **只在放大对某些内容毫无变化时才实现**。比自身高度上限矮的表格根本没被裁，取消封顶一个像素都不变 —— 那种情况不该给按钮。不实现 = 永远提供。 |

**`available()` 只能问"有没有东西被藏起来"，不能问"值不值得"。** 判据用
`scrollHeight > clientHeight`（真正的溢出测试），不要用行数或字符数：同样行数换个字号
高度就不同，单元格还会折行。`0/0` 视为"没有布局信息"，给按钮 —— 猜错方向只是多一个
不太有用的按钮，猜"不"会藏掉唯一的出路。

**弹窗要挂在 `document.body` 上，不要挂进块里。** 两条都是硬要求：`viewRoot` 每次切视图
都会被清空，而会话是**虚拟化**的，块可能在弹窗还开着时就被回收。

**样式上有一条容易踩的**：控件的**状态规则和 `:hover` 权重相同**，比的是书写顺序 ——
状态规则写在 `:hover` 后面就会**静默吃掉** hover。所以这个控件**不要有任何状态样式**；
真需要，用一个不会与 `:hover` 同权重的选择器。

---

## 9. 自测

渲染器本身是纯函数式的，接缝测试夹具已经现成可用：

```js
import { createMermaidRenderer } from '../src/client/renderers/mermaid.js'
import { createEnvironment, parseHtml } from './dom-shim.mjs'
import { codeBlockFixture, conversationFixture } from './fixtures.mjs'

const env = createEnvironment()
parseHtml(conversationFixture([
  { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'mermaid', code: 'graph TD; A-->B;' }) },
]), env.document.body)
// …建 kit、注册渲染器、跑 seam，断言 `[data-dvk-switch]` 出现了
```

`tests/run.mjs` 里的 `mount()` 辅助函数已经封装好了这套流程，
新增渲染器时照抄 "second renderer" 那一节即可。

跑构建与测试（命令与 [AGENTS.md](../AGENTS.md) §2 相同）：

```powershell
fnm use          # 仓库用 .node-version 声明 Node 24；tsdown 需要 ≥ 22
pnpm run build   # 必须先构建，bundle 测试跑的是产物
pnpm test
```

> 构建是标准的 tsdown 管线，产物格式（`window.__ModuleLoader__.load({ id, factory })`）
> 定义在 `tsdown.config.ts`。**自包含**渲染器不需要关心它——正常写 ESM 即可，
> 相对 import、命名导出、`export const` 都支持。

### 9.1 要引入引擎库时（带引擎渲染器）

一个 1 MB 以上的库**不能**内联进入口 bundle：它会让每个用户、每次启动都付这个代价。
本 kit 的做法是把它拆成独立文件、按需 fetch，用的**是 DSH 原生的 chunk 机制**，
不是自建路由。四条契约（全部从 `@deepseek-ai/dsh-client-modules` 与宿主路由读出，
并可用 `scripts/probe-chunk.mjs` 复验）：

1. **文件名**必须匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`，且与入口**同目录**；
2. **不能带内容 hash** —— chunk 的 id 是 `<包名>/<文件名>` 而它要自己注册这个 id，
   带 hash 就自指循环。也不需要：请求 URL 带有入口文件的 `?rev=`，重建必然换 URL；
3. **入口必须用 `require.async('./client.x.js')`，不能用 `import()`** ——
   CJS 下 `import()` 编译成普通 `require`，会抛 `missed the module table`；
4. **每个产物需要各自的 `__ModuleLoader__.load({ id })`**，所以 `banner` 必须是
   以 chunk 名为参数的**函数**。

引擎声明为**第二个 entry**而非代码分割产物：第 3 条的请求是一个没有 import 表达式
支撑的字符串，打包器看不见它。

还要检查**引擎里有没有 Node 惯用法**。ECharts/zrender 会判断
`process.env.NODE_ENV`（实测 236 处），浏览器没有 `process`，chunk 一求值就抛
`process is not defined`。用构建期 `define` 替换掉，值是 **JSON 引号形式**
（裸的 `production` 是语法错误）：

```ts
define: { 'process.env.NODE_ENV': JSON.stringify('production') }
```

`tests/run.mjs` 里有一节专测这些产物性质（chunk 不含活跃 `process` 引用、
入口不含引擎代码、注册 id 与文件名一致、tarball 里带着 chunk）——
**夹具里的假引擎永远测不出这类问题，必须读真实产物。**

---

## 10. 提交前自查

**自包含渲染器：**

- [ ] 只新增/修改了 `renderers/` 下的文件和 `index.js` 里的一行
- [ ] `match()` 是纯函数，不抛异常（真会抛也要能被外层兜住）
- [ ] **`match()` 在 `lang === ''` 时仍然能靠内容做出判断**（见 §2.1）
- [ ] `dispose()` 释放了所有副作用（定时器、`ResizeObserver`、子组件、事件监听）
- [ ] 没有 `innerHTML` / `insertAdjacentHTML` 用来放模型的原始文本
- [ ] 需要沙箱的地方，`sandbox` 和 `allow-same-origin` 没有同时出现
- [ ] `t('view.<id>', …)` 在中英字典里都补了（**键集合必须相同**，测试会断言）
- [ ] 注释写的是不变式与失败模式，不是"这个 bug 是谁报的 / 哪次对话里发现的"
      （判据与正反例见 [AGENTS.md](../AGENTS.md) §4.1；有测试扫描）
- [ ] `pnpm run check` 全绿（类型检查 + 构建 + 测试 + 宿主契约探针）

**带引擎渲染器，额外：**

- [ ] 引擎在 `chunks/` 里，入口 bundle 体积没有明显增长（有测试守着）
- [ ] chunk 文件名满足宿主路由的 `CLIENT_CHUNK` 模式，且注册的 id 与之一致
- [ ] 入口用 `require.async`，没有动态 `import()`
- [ ] chunk 里没有活跃的 `process` / `node:` 引用（有测试守着）
- [ ] 引擎加载失败时**显示可读原因**而不是空白框（用户拿到的是 HTTP 状态码或导出键名）
