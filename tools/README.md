# dsh contract tools

Three small PowerShell helpers for re-checking the DSH DOM contract when the
host is upgraded. They read the packaged `app.asar` directly, because that is
where the shipped plugin bundles live on a desktop install.

The usual trigger is "DSH updated, do we still work?" (README → 升级 DSH 之后).

## The asar header

`app.asar` is four little-endian `uint32`s, then the JSON header:

| offset | value |
|---|---|
| 0 | `4` |
| 4 | pickle payload size (this is also the data offset minus 8) |
| 8 | payload's own `uint32` |
| 12 | **actual JSON byte length** — read the header from here, not from 12 |
| 16 | JSON |

File bytes live at `8 + headerSize` + the entry's `offset`. Getting the JSON
length wrong reads four bytes of pickle padding as the start of the header,
which is a confusing failure; `asar-extract.ps1` has the working sequence.

## Usage

```powershell
# one file out of the archive
.\asar-extract.ps1 -Path dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js

# what is in a subtree
.\asar-tree.ps1 -Prefix dsh/node_modules/@deepseek-ai -MaxDepth 0

# every path, filtered
.\asar-files.ps1 -Filter 'dsh-client-ui-chat'
```

Default source: `D:\Program Files\DeepSeek Harness\resources\app.asar`.
Override with `-Root`, and pick the output directory with `-OutDir`.

## What to check after an upgrade

The three files that define everything the kit relies on:

| file | what to re-verify |
|---|---|
| `dsh-client-ui-primitives/lib/index.js` | `CodeBlock` still emits `md-code-block`, `data-code-block-banner`, `data-code-block-content`; the streaming body is still a bare `<pre>` and the settled body still wraps in a `<div>` |
| `dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css` | the "stable content node" comment is still there — that comment is the licence for this whole approach |
| `dsh-client-ui-chat/lib/client.js` | `markdownLabels()` still passes `toolbarLabels`, which is what makes the card-shaped banner the one that ships |

Then run `pnpm run check` (typecheck + tsdown build + tests) — the fixtures and
assertions will tell you what moved.
