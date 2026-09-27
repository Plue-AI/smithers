/**
 * `@smthrs/create-app`: declare a Smithers app in one `PACKAGE.ts`.
 *
 * An app is a directory with four kinds of file. `PACKAGE.ts` calls
 * {@link CreateApp}. `AGENT.ts`, `SANDBOX.ts`, and `TOOLS.ts` are layer files.
 * `flows/<id>/flow.ts` is a flow. `app/**\/page.tsx` and
 * `app/panes/<name>.tsx` are the UI. Nothing else names anything: the router
 * derives every route, every pane name, and every flow's three layers from
 * file location alone.
 *
 * This entry point re-exports the two halves of the authoring surface flat,
 * rather than as namespaces, because it is an authoring API rather than a
 * service API — an app writes `defineFlow`, not `App.defineFlow`.
 *
 * Three subpaths ship into a running app and bundle for the browser and for
 * workerd: `./app` (layer files, flow files, types), `./ui` (panes and cards),
 * and `./runtime` (flows made executable), which is what a scaffolded
 * Cloudflare Worker imports. The rest are Node-only build and test tooling:
 * `./package` (`CreateApp` over `@smthrs/targets`), `./router` (the file
 * router), `./vite` (the plugin), `./testing` (`cachedModelTest`), and
 * `./routesBin` (the `smithers-routes` body). This entry point re-exports
 * `./package`, so it is Node-only too; `sideEffects: []` lets a bundler drop
 * the Node half from a browser or Worker bundle that imports only
 * `defineAgent` and friends. `test/bundle.test.ts` holds each subpath to that
 * classification.
 *
 * @since 0.1.0
 */

export * from "./app.ts"
export * from "./package.ts"
