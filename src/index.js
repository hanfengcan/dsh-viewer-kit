/**
 * dsh-viewer-kit — host half.
 *
 * ## What this half is for
 *
 * Rendering happens entirely in the browser, so this half contributes no
 * rendering behaviour. It exists because the configuration a user writes in
 * `cordis.patch.yml` cannot reach the browser on its own:
 *
 *   - a patch row's `config:` block becomes the **host** fiber's config
 *     (`apply(ctx, config)`), and stops there;
 *   - the boot wire carries no config at all — `graphRow()` emits
 *     `{id, url, rev, inject?, immediately?, external?}` and
 *     `parseBootManifest()` reads back exactly those fields — so the client
 *     half's `apply(ctx, rowConfig)` is always called with `undefined`.
 *
 * So this half does two things: validate the row strictly, and publish the
 * result over one read-only HTTP route that the client fetches before its
 * first scan.
 *
 * It also registers `apply_prototype_style` and the one-shot prompt section
 * behind it (`./tools/apply-prototype-style.js`), which is the only part of the
 * kit that runs inside the model's own turn loop rather than the browser.
 *
 * This is a workaround for a gap in DSH, not a designed channel. The community
 * plugin `dshmarket` bridges the same way (host `apply(ctx, config)` plus
 * `webServer.register`, client `fetch`), which is the precedent it follows.
 * `tools/probe-host.mjs` fails `pnpm run check` if DSH ever adds config to the
 * wire, because that is the day to delete this file and read the row directly.
 *
 * @module host
 */

import { Config, DEFAULT_CONFIG, resolveConfig } from './schema.js'
import { registerPrototypeStyle } from './tools/apply-prototype-style.js'

export { Config, DEFAULT_CONFIG }

/**
 * Required services.
 *
 * Waiting for `webServer` means `apply` runs only where a route can exist; on a
 * host without it this half simply never activates, and the client half falls
 * back to the shipped defaults.
 *
 * `systemPrompt` and `tools` are hard dependencies because prototype mode
 * registers into both, and a half that registered a tool with no section behind
 * it would arm a flag nothing ever reads.
 */
export const inject = ['webServer', 'systemPrompt', 'tools']

/**
 * The slice of the Host context this half uses, written out rather than
 * imported.
 *
 * `lib/index.js` is a verbatim copy loaded by a host that augments cordis's
 * `Context` with its own services in whichever module declared them. Spelling
 * the three members out here documents the contract this file actually depends
 * on — which is the point of `tools/probe-host.mjs` being able to check it —
 * and keeps `tsc` meaningful without a dev dependency on every service package.
 *
 * @typedef {object} HostContext
 * @property {(callback: () => unknown, label?: string) => unknown} effect
 *   Runs `callback` immediately and uses its return value as the disposer.
 * @property {{ register: (route: { kind: string, path: string, handler: (request: any, response: any) => void }) => () => void }} webServer
 *   Route table. `register` returns the disposer and **throws on a duplicate
 *   (kind, path)**, which is why the registration lives in an effect.
 * @property {import('./tools/apply-prototype-style.js').PrototypeContext['tools']} tools
 * @property {import('./tools/apply-prototype-style.js').PrototypeContext['systemPrompt']} systemPrompt
 */

/**
 * Where the resolved config is published.
 *
 * Root-absolute on purpose: this is the path the **host** registers, and the
 * host's own route table is keyed on it. The client resolves it document-
 * relatively before requesting (see `src/client/host-config.js`) — dshmarket
 * shipped root-absolute fetches first and had to fix them, because the same
 * string means something different once the app is mounted under a prefix.
 */
export const CONFIG_ROUTE = '/dsh-viewer-kit/config'

/**
 * @param {HostContext} ctx Host context.
 * @param {Record<string, unknown>} config Validated against {@link Config}.
 * @returns {() => void} Disposer releasing the prototype-style registrations.
 */
export function apply(ctx, config) {
  // Cordis has already run the schema above, so every key is present and
  // correct. `resolveConfig` is called anyway for one reason: it makes this
  // route's answer independent of whether the schema export is honoured, so a
  // future DSH that stops reading `Config` degrades to defaults served over
  // HTTP rather than to `undefined` served over HTTP.
  const resolved = resolveConfig(config)

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        // `no-store` because this is a control surface, not an asset: a cached
        // value would keep rendering the previous settings after a reload.
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(JSON.stringify(resolved))
      },
    })
    // `effect` runs this callback NOW and takes its return value as the
    // disposer, so the route is removed on unload. That matters beyond tidiness:
    // `webServer.register` throws on a duplicate (kind, path), so a reload that
    // failed to unregister would break the next activation outright.
    return dispose
  }, 'dsh-viewer-kit: config route')

  // A loud, one-line record of what the browser is about to be told. The
  // client logs its own view of the same values; a mismatch between the two
  // lines is the fastest way to spot a stale route or an old bundle.
  // eslint-disable-next-line no-console
  console.log(`[dsh-viewer-kit] host config published at ${CONFIG_ROUTE}: ${JSON.stringify(resolved)}`)

  // Returned rather than wrapped in an effect: both registrations are already
  // scoped to this fiber, and cordis runs a disposer returned from `apply` on
  // unload. Registering inside an effect here would ALSO run it immediately, so
  // the tool and the section would come up before the route above does.
  return registerPrototypeStyle(ctx, resolved)
}
