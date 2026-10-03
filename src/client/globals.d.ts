/**
 * The module table's `require`, aliased by the build banner.
 *
 * The client module system hands the bundle factory a `require` that resolves
 * against the shell's frozen module table. Inlined modules cannot name it, so
 * `tsdown.config.ts` declares `var __dvkRequire = require;` at the top of every
 * emitted file. This is the only place that identifier is allowed to appear.
 */
declare const __dvkRequire: {
  (spec: string): any
  async (spec: string): Promise<any>
}
