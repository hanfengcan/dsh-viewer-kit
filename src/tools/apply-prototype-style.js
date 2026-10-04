/**
 * One-shot HTML prototype style injection.
 *
 * ## What this half is for
 *
 * The kit renders HTML that the model already wrote. This module changes how
 * that HTML is *written*, for exactly one response at a time: the model calls
 * `apply_prototype_style`, and the next assembled request carries a style
 * specification that does not appear in any other request.
 *
 * ## Why the model never closes it
 *
 * The obvious design is a tool that turns the mode on and another that turns it
 * off. That makes the lifetime of a prompt section a decision the model has to
 * remember to make, and a model that forgets leaves a style constraint welded
 * into every later turn of the conversation.
 *
 * So the model only ever opens it. Ownership of the state sits with
 * {@link PROTOTYPE_SECTION}'s `text` function, which the system prompt
 * reassembles before every model step: it hands back the specification and
 * clears itself in the same turn. There is no window in which the model can
 * forget, because closing is not something the model does.
 *
 * The cost is that `text` is called on *every* assembly rather than on the one
 * that matters, which is why the idle path is a boolean test and returns `''` —
 * the assembler drops empty sections, so an unarmed model pays one branch and no
 * tokens.
 *
 * ## The lifetime is one assembly, not one tool call
 *
 * The specification is consumed by whatever assembles next. Normally that is the
 * model step immediately after the tool result — the only thing that can follow
 * it — so "one response" is what a user observes. But a tool call that is
 * aborted before the step that reads it leaves the flag armed, and the next
 * unrelated turn is the assembly that consumes it. The failure is one stray
 * specification in one later turn, which is a far better failure than a section
 * that never goes away, and it is the direct price of not trusting the model to
 * clean up after itself.
 *
 * @module tools/apply-prototype-style
 */

import { prototypeStyleSpec } from '../schema.js'

/**
 * The tool the model calls to arm the injection.
 *
 * Registered globally rather than in an agent scope, so every session in the
 * process sees it. The section below is registered the same way, and the two
 * must stay in step: a tool with no section would arm a flag nothing reads.
 */
export const PROTOTYPE_TOOL = 'apply_prototype_style'

/**
 * Section name for the injected specification.
 *
 * Namespaced by plugin because `systemPrompt.section` throws on a duplicate
 * within one layer — an unprefixed `prototype-style` would be one rename away
 * from colliding with another plugin's contribution.
 */
export const PROTOTYPE_SECTION = 'dsh-viewer-kit:prototype-style'

/**
 * Where this section lands in the assembled prompt.
 *
 * A raw number rather than `getSectionOrder(name)`, because no named placement
 * means "after the persona and before tool guidance" — the named orders are
 * fixed points owned by the host, and the gap this belongs in has no name.
 *
 * `50` is inside that gap as of this host: `DEPLOYMENT_PERSONA_PREFIX` is `0`
 * and `PLAN_POLICY` is `500`, so nothing is displaced. The named tool-guidance
 * sections start much later, at `TOOL_BASH: 1000`, so the specification is read
 * before any tool instructions rather than being buried under them.
 *
 * This is the one value here that a host upgrade can invalidate. If a future
 * host adds a section into the `0..500` band, re-check the placement rather
 * than assuming it still holds.
 */
const SECTION_ORDER = 50

/**
 * What the model is told when it arms the mode.
 *
 * Phrased so the model needs no follow-up action: it says the injection is
 * already handled and expires on its own, which is what stops a model from
 * inventing a "leave the mode" tool call to clean up after itself.
 */
const ARMED_CONFIRMATION = [
  'Prototype style armed. The style specification is being injected into the',
  'next request, not this one. Emit the HTML prototype in your next response',
  'following it. The specification expires after that response on its own; you',
  'do not need to do anything to turn it off.',
].join(' ')

/**
 * The slice of the Host context this module uses.
 *
 * Spelled out rather than imported, for the same reason `src/index.js` spells
 * out its own: `tools/probe-host.mjs` verifies the contract against the host,
 * and `tsc` stays meaningful without a dev dependency on every service package.
 *
 * @typedef {object} PrototypeContext
 * @property {{ register: (definition: unknown) => () => void }} tools
 * @property {{ section: (section: {
 *   name: string,
 *   order: number,
 *   text: string | ((context: { scope?: object }) => string),
 * }) => () => void }} systemPrompt
 */

/**
 * The tool's declared result.
 *
 * `armed` is a constant rather than a reflection of real state: the whole
 * contract is "calling this arms it", so reporting anything else would be a
 * claim about a flag whose lifetime belongs to the prompt assembler.
 */
const PROTOTYPE_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      armed: {
        type: 'boolean',
        description: 'Always true. The specification is injected into the next assembled request.',
      },
    },
    required: ['armed'],
    additionalProperties: false,
  },
  render: () => [{ type: 'text', text: ARMED_CONFIRMATION }],
}

/**
 * Register the tool and the one-shot prompt section.
 *
 * @param {PrototypeContext} ctx Host context, with `systemPrompt` and `tools`
 *   already present — both are declared in this module's `inject`.
 * @param {{ prototypeStyle: string }} config A resolved config; its
 *   `prototypeStyle` is read once here rather than per injection, because a
 *   config cannot change under a running plugin and re-deriving forty lines of
 *   prompt on every assembly would be work for a constant.
 * @returns {() => void} Disposer for BOTH registrations.
 */
export function registerPrototypeStyle(ctx, config) {
  const spec = prototypeStyleSpec(config)

  /** @type {boolean} Armed by the tool, cleared by the section's own `text`. */
  let armed = false

  const disposeTool = ctx.tools.register({
    name: PROTOTYPE_TOOL,
    description: [
      'Call this BEFORE emitting an HTML prototype, to have a fixed style',
      'specification injected into your very next request.',
      'It sets style rules only; you still design and write the HTML yourself.',
      'The specification applies to that one response and then expires by',
      'itself; you do not need to switch it off afterwards.',
      'Use it when the user asks for a prototype, mockup, wireframe or page',
      'layout. Do not call it for ordinary HTML snippets, code explanations,',
      'or any reply that is not a prototype.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {},
    },
    output: PROTOTYPE_OUTPUT,
    // No `isConcurrencySafe`, which leaves this call EXCLUSIVE: the tools
    // pipeline treats an absent or non-`true` classifier as exclusive. That is
    // what this tool needs — it flips state that the next prompt assembly
    // reads, so two of these must not interleave with each other.
    execute() {
      armed = true
      return Promise.resolve({ armed: true })
    },
  })

  const disposeSection = ctx.systemPrompt.section({
    name: PROTOTYPE_SECTION,
    order: SECTION_ORDER,
    // A function, not a string, because the whole feature is that its value
    // changes between two assemblies of the same registered section.
    text: () => {
      if (!armed) return ''
      // Cleared on the way out, not after. If the text were built and the flag
      // cleared in two steps, a throw between them would leave the section
      // permanently armed; returning from this branch is the only place the
      // flag can be observed, so it is also the only place it is reset.
      armed = false
      return spec
    },
  })

  return () => {
    disposeTool()
    disposeSection()
  }
}
