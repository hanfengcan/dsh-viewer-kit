# 写一个新的渲染器

> 这份文档面向"以后要往 kit 里加东西"的你。
> 读完之后你应该能只新建 **一个文件**、加 **一行注册**，就得到一个新渲染器，
> 而不需要读 `kit.js`、`dom-seam.js` 或 `code-block-surface.js`。

> 这不是承诺，是已经发生过的事：`renderers/table.js` 是在 `html.js` 之后
> 单独加进去的，当时内核与接缝一行都没改，也没有多写一个 DOM 夹具。

---

## 0. 你需要改动的全部

```
src/client/renderers/<你的渲染器>.js     ← 新建，就这一个文件
src/client/index.js 的 RENDERER_FACTORIES ← 加一行
```

没了。没有新的 slot、没有新的 DOM 选择器、没有新的测试夹具。

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
  limits: { maxSourceBytes, maxPreviewHeight },
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

跑构建与测试（见 [README 快速开始](../README.md#快速开始)）：

```powershell
fnm use          # 仓库用 .node-version 声明 Node 24；tsdown 需要 ≥ 22
pnpm run build   # 必须先构建，bundle 测试跑的是产物
pnpm test
```

> 构建是标准的 tsdown 管线，产物格式（`window.__ModuleLoader__.load({ id, factory })`）
> 定义在 `tsdown.config.ts`。你写渲染器时**不需要关心它**——正常写 ESM 即可，
> 相对 import、命名导出、`export const` 都支持。

---

## 10. 提交前自查

- [ ] 只新增/修改了 `renderers/` 下的文件和 `index.js` 里的一行
- [ ] `match()` 是纯函数，不抛异常（真会抛也要能被外层兜住）
- [ ] `dispose()` 释放了所有副作用（定时器、`ResizeObserver`、子组件、事件监听）
- [ ] 没有 `innerHTML` / `insertAdjacentHTML` 用来放模型的原始文本
- [ ] 需要沙箱的地方，`sandbox` 和 `allow-same-origin` 没有同时出现
- [ ] `t('view.<id>', …)` 在中英字典里都补了
- [ ] `pnpm run check` 全绿（类型检查 + 构建 + 测试）
