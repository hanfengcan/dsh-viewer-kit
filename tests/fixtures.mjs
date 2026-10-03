/**
 * Fixtures copied from what `@deepseek-ai/dsh@0.2.0-rc.2` actually renders.
 *
 * The class names are the hashed CSS-module names from the shipped bundles;
 * they are not part of the contract and the kit must not depend on them. What
 * the kit does depend on — `.md-code-block`, `[data-code-block-banner]`,
 * `[data-code-block-content]`, and the two shapes the content node takes while
 * streaming versus settled — is exactly what these fixtures pin.
 *
 * Sources:
 *   `dsh-client-ui-primitives/lib/index.js:10873-10914`  (CodeBlock)
 *   `dsh-client-ui-primitives/lib/index.js:10823-10872`  (streaming vs settled body)
 *   `dsh-client-ui-chat/lib/client.js:198-211`           (the chat always passes
 *                                                         toolbarLabels, so the
 *                                                         card-shaped banner is
 *                                                         the one that ships)
 *
 * @module tests/fixtures
 */

/**
 * A code block shaped the way DSH actually renders it.
 *
 * `highlighted: false` reproduces the case that broke the chart renderer in the
 * product. `CodeToolbar` renders `supportsHighlighting(lang) ? lang : <fallback>`,
 * so a fence whose language DSH has no grammar for comes out as:
 *
 *   - a banner whose language chip is generic copy (here the observed `代码块`),
 *     NOT the fence name — the name is not in the DOM at all; and
 *   - a body that stays `<pre class="_plain_…">` in BOTH the streaming and the
 *     settled phase, because there is nothing to highlight.
 *
 * Every fixture that passed before this option existed was highlighted *and*
 * correctly labelled, so neither failure could be observed. Both facts are from
 * a real DOM capture of an `echarts` fence, not inferred.
 *
 * @param {{ lang: string, code: string, streaming?: boolean, highlighted?: boolean, genericLabel?: string }} options
 * @returns {string}
 */
export function codeBlockFixture(options) {
  const { lang, code, streaming = false, highlighted = true } = options
  const genericLabel = options.genericLabel ?? '代码块'
  const pre =
    'class="shiki css-variables" style="background-color: var(--shiki-background); color: var(--shiki-foreground)" tabindex="0"' +
    `<code><span class="line">${escapeHtml(code)}</span></code>`

  // The decisive difference: while streaming the content node's element child
  // IS the <pre>; once settled and highlighted it is a wrapping <div>. An
  // unhighlightable language never gets that wrapper, in either phase.
  const plain = `<pre class="_plain_x">${escapeHtml(code)}</pre>`
  const content = !highlighted
    ? plain
    : streaming
      ? `<pre ${pre}></pre>`
      : `<div class="shiki"><pre ${pre}></pre></div>`

  // The chip shows the language only when a highlighter exists for it.
  const label = highlighted ? lang : genericLabel

  return `
<div class="Zv7Kq_block Zv7Kq_card md-code-block" data-code-wrap="true">
  <div class="Zv7Kq_bannerWrap">
    <div class="Kp2Wc_header" data-code-block-banner>
      <div class="Kp2Wc_heading"><span class="Kp2Wc_language">${escapeHtml(label)}</span></div>
      <div class="Kp2Wc_actions">
        <button type="button" class="Kp2Wc_action" aria-label="Wrap" aria-pressed="true"></button>
        <button type="button" class="Kp2Wc_action" aria-label="Copy"></button>
      </div>
    </div>
  </div>
  <div class="Zv7Kq_content" data-code-block-content>${content}</div>
</div>`
}

/**
 * The conversation chrome the seam scopes against.
 *
 * `data-chat-node-key` lives on the chat flow row, one level above the code
 * block — that is where `dsh-client-ui-chat` puts it, and the seam reads it
 * through `closest()`.
 *
 * @param {Array<{ nodeKey: string, html: string }>} entries
 * @returns {string}
 */
export function conversationFixture(entries) {
  const rows = entries
    .map((entry) => `<div data-chat-node-key="${entry.nodeKey}">${entry.html}</div>`)
    .join('\n')
  return `<div data-slot="conversation.session">\n${rows}\n</div>`
}

/** @param {string} text */
function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export const HTML_SAMPLE = [
  '<!doctype html>',
  '<style>body{font:16px system-ui;margin:24px}h1{color:#2b6}</style>',
  '<h1>Hello from the preview</h1>',
  '<p>This document is rendered inside a sandboxed frame.</p>',
].join('\n')

export const PYTHON_SAMPLE = ['def greet(name):', '    return f"hi {name}"'].join('\n')
