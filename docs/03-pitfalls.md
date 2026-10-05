# 平台陷阱与已排除的方案

> 本文收集两类内容：**看起来是某样东西、实际不是**的平台事实，
> 以及**已经排除、不必再评估**的方案。
>
> 每一条都是静态事实，不是经历记录：它说明 DSH / 工具链**是什么**，
> 因此**哪条推论不成立**。要重新评估其中任何一条，先看证据位置。
>
> 架构原理、分层、算法在 [01-architecture.md](01-architecture.md)；
> 新增渲染器的契约在 [02-renderer-authoring.md](02-renderer-authoring.md)。

核对基线：`@deepseek-ai/dsh@0.2.0-rc.2`。

---

## 1. `data-chat-running` 不是作用域标记

它的名字与位置都指向"这一回合还在跑"，但它挂在 `RunningStatus` ——
回合**内容之后**的一个"深度思考中"指示器，是 flow item 的**兄弟节点而非祖先**
（`dsh-client-ui-chat/lib/client.js:3918-3920`）。

```js
element.closest('[data-chat-running]')   // 对任何代码块恒为 null
```

作为流式守卫它**一次都不会触发**。流式保护的真实判据是内容节点的形态差异
（见 `01-architecture.md` §5.3）。

该常量仍留在 [`dom-contract.js`](../src/client/dom-contract.js) 里，
带一行说明它**不是**作用域标记——删掉它等于把这个推论重新做一遍。

## 2. `cordis.patch.yml` 是生成物

Loader 的那些行由插件管理器生成，指向包内的 patch 文件。手工在末尾加的
`insert` 行会被 DSH 通过 `app-boot/config-reload` 正常热加载，`fiberPhase`
变成 `active`，**下一次 `dsh plugin add` 之后连同上下文一起消失**，无报错。

因此：热加载成功 ≠ 安装持久。唯一写入者是插件管理器，包通过
`dsh plugin add` 进入 `dependencies` 与 `profile.bundles`，Loader 那一行随之可再生。

## 3. pnpm 拷贝目录依赖，不建立硬链接

`pnpm add file:<dir>` 把依赖**拷贝**进 `node_modules`。只改仓库里的构建产物，
profile 那份**纹丝不动**，且任何地方都不报错。`install_bundle` 在 lockfile 未变时
回 `Already up to date` 并拒绝重装。

判定方法（可复现）：给产物的某个标记位打一个**追加**探针，改仓库那份，
再看 profile 那份是否变化。硬链接会一起变，拷贝不会。

同步手段见 [`AGENTS.md`](../AGENTS.md) §3。

## 4. 客户端 `ctx` 只有三个成员可用

cordis 的 `Context` 是 proxy，**读未注册成员直接抛**。抛在 `apply` 里等于
**web boot 失败**，而 DSH 把这种失败当致命启动错误。builtin 文档的措辞是
"prefer `ctx.get(name)` with an undefined check"。

| 成员 | 真实语义 |
|---|---|
| `ctx.get(name)` | 唯一被许可的读取入口。未注册的 name 返回 `undefined` |
| `ctx.effect(fn, label)` | **立刻调用** `fn`，并把它的**返回值**当 disposer |

`AGENTS.md` §5.5 的允许清单更宽（`get` / `effect` / `on` / `provide`），
本插件实际只用到上面两个。`document` / `console` / `MutationObserver` 是浏览器全局，
**不在 `ctx` 上**。样式表自己插 `<style data-plugin="dsh-viewer-kit">` 并在
disposer 里移除。

真实客户端 context 混入了 16 个成员（cordis `reflect.ts:219-222`），
加宽 harness 等于删掉那道守卫。

## 5. `locale.bind(ns)` 返回的就是翻译函数

```js
const t = ctx.locale.bind(NS)   // t 本身是函数，不是带 .t 的对象
t('key')
```

`locale.bind(ns).t(key)` 会抛 TypeError。这个错误被接缝的逐块 try/catch 吞掉，
症状与"没有渲染器认领"完全一样。

字典注册因此由 `locale.js` 自己持有并返回自己的 disposer，不挂在 `ctx.effect` 上：
**effect 的 disposer 属于 fiber**，HMR 或重新启用让上一个实例退役时走的不是它，
注册会被留在原地，下一次 `register` 就撞
"locale namespace … already has locale …"——那会让整个 entry 失败并拖垮 boot 审计。
`createTranslator` 额外在 `register` 外面包了 catch：重复注册时内容完全相同，
继续 bind 自己的那份即可，为它抛错没有意义。

## 6. 宽松的 `ctx` stub 比没有测试更坏

`apply` 的 stub 若对任意属性返回 `undefined`、且 `effect` 只把回调存起来不调用，
它就**无法建模**第 4、5 条的任何一条约束。测试全绿而产品在真实 runtime 里崩溃，
是这个组合的必然结果。

[`tests/ctx-harness.mjs`](../tests/ctx-harness.mjs) 因此刻意**比真宿主更窄**：
只暴露上表三个成员，读别的即抛。它是**下限而不是镜像**——加宽它等于删掉那道守卫。

`pnpm run repro` 用同一套 harness 跑**构建产物**并打印栈：
崩溃日志里只有 `<name>: failed`，真正的栈只进浏览器控制台。

## 7. 滚动补偿的两种判据会给出错误答案

认领一个块必然改变它的高度（`01-architecture.md` §6）。补偿量本身是
`delta = after.height - before.height`，无歧义；有歧义的是**要不要补**。

| 判据 | 为什么错 |
|---|---|
| 块与视口**有交集**就补 | 一份长源码进场时通常只露 `sliver` 底边、绝大部分已在视口之上，而视口里绝大部分是块**下方**的内容——那些才是要保的。按交集判定会跳过真正出事的那一次 |
| 视口上下**同号**补偿 | 块的高度变化只移动它**下方**的内容。块在中线之下时，块本身与其上方的内容都不动 |
| 变更后判断"是否贴底" | 高度一收缩，文档就短了。拿变更前的 offset 去比变更后的 `scrollHeight`，每个人都会被判成越界，而越界恰恰是唯一必须补偿的情况 |

正确判据（`scroll-guard.js:139`）：**`before.bottom < viewport.top + viewport.height / 2`**
才补偿。宿主是否在跟随尾部由 `scroller.closest(FOLLOWING_TAIL_SELECTOR)` 回答，
且**必须在 `change()` 之前读**。

## 8. 打包格式由配置声明，不由正则保证

产物格式是 `window.__ModuleLoader__.load({ id, factory })`，
factory 内的 `require` 解析基线模块表。这个契约集中定义在
[`tsdown.config.ts`](../tsdown.config.ts) 一处：`format: 'cjs'`（DSH 消费的不是 ESM）
+ banner 外壳 + factory 内自建 `module` / `exports` 对 + `entryFileNames: '[name].js'`
（把 tsdown 默认的 `client.cjs` 拉回 DSH 约定的 `client/client.js`）。

用自写正则做 ESM→`__ModuleLoader__` 转换能跑通，但格式契约就散进了构建脚本。
换标准管线的直接收益是 `tsc --noEmit` 立刻开始对 `src/**/*.js` 的 JSDoc 生效。

## 9. asar 头部：`DATA_BASE = 8 + headerSize`

`app.asar` 是四个小端 `uint32`，然后是 JSON 目录树：

| 偏移 | 内容 |
|---|---|
| 0 | `4` |
| 4 | pickle payload 大小（**也是数据偏移减 8**） |
| 8 | payload 自己的 `uint32` |
| 12 | **JSON 的实际字节长度**——从这里读，不是从 12 |
| 16 | JSON |

文件字节位于 `8 + headerSize` + 条目的 `offset`。**`16 + headerSize` 是错的**：
差 8 字节会让每个文件都读到前一个文件的尾巴，小文件直接截断，
而大文件看起来完全正常。

`tools/asar-tree.ps1` / `asar-files.ps1` / `asar-extract.ps1` 是可用的实现。

## 10. 目录不是注册表

`src/client/renderers/` 与 `src/tools/` 都**不被扫描**。新增文件必须同时
在 `src/client/index.js` 的 `RENDERER_FACTORIES`（或 `src/index.js` 的显式
import）里登记，否则它不参与运行。目录表达的是"同类聚合"，不是"加了文件就跑"。

## 11. 状态规则与 `:hover` 同权重时，书写顺序决定胜负

一个状态选择器和一个 `:hover` 规则权重相同，后写的赢。把状态规则放在
`:hover` 之后会**静默吃掉** hover——没有报错，只是悬停不响应。

放大控件因此不写任何状态样式；确需区分时用一个不会与 `:hover` 同权重的选择器。

## 12. `webServer.register` 对重复的 `(kind, path)` 直接抛

所以配置路由的注册必须包在 `ctx.effect` 里——`effect` 立刻执行回调并把
返回值当 disposer，路由因此在停用时被摘掉。摘不掉的注册会让下一次激活
直接失败（`webServer: duplicate exact route`）。

## 13. 遮蔽 `conversation.chat.node[assistant-step]` 的成本

技术上可行：`priority: -1` 即可遮蔽（`dsh-client-ui-slots/lib/index.js:168-186`，
提示语原文 "register at a different priority to shadow it"）。但那要求重写
`AssistantMarkdown` 的全部行为——正文、思维链折叠、图片分组、停止徽标、
两个子 slot 的透传、流式 shimmer 与 presentation 策略——而 `ctx.slots` 只有
`register` / `registerFactory` / `inject`，被遮蔽的 occupant 不对消费者暴露，
**没有回退到官方实现的手段**。

收益是一个围栏的切换按钮。这个交换不成立。
