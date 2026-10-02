import react from "@vitejs/plugin-react"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import type { Plugin } from "vite"
import { buildStamp, resolveBuildSha } from "./scripts/build-stamp"
import { assertAcyclicChunks } from "./scripts/chunk-graph"

/*
 * Every vite invocation in package.json passes `--configLoader runner`. The
 * app graph reaches `@smthrs/rpc`, a workspace package that ships
 * TypeScript source; the default `bundle` loader hands bare specifiers to
 * node's ESM loader, which cannot resolve that package's extensionless
 * relative imports. The runner loader resolves the config through Vite
 * itself, so the workspace source loads the same way it does in the app graph.
 */

/*
 * Resolved against this file, not the shell's working directory: `vite
 * --config apps/app/vite.config.ts` from the repository root used to serve 404s
 * because a bare "src/mainview" resolved under the root instead. Every path
 * below is absolute for the same reason.
 */
export const here = fileURLToPath(new URL(".", import.meta.url))

/*
 * CN-1: the build stamp lives in scripts/build-stamp.ts so the smithers.sh
 * site build can stamp the island the same way; this build wires it in below
 * and keeps exporting it for the scripts that imported it from here.
 */
export { buildStamp, resolveBuildSha }

/*
 * Guard every static output cycle, not only imports back to the entry. The
 * vendor size splitter also produced vendor-only Effect initialization cycles
 * ("dual is not a function") before even the startup watchdog could run.
 */
const entryChunkGuard = (): Plugin => ({
  name: "smithers-entry-chunk-guard",
  generateBundle(_options, bundle) {
    const chunks = Object.values(bundle).filter((item): item is Extract<typeof item, { type: "chunk" }> => item.type === "chunk")
    assertAcyclicChunks(chunks)
  }
})

export default defineConfig({
  server: process.env.SMITHERS_DEV_BACKEND_ORIGIN ? {
    proxy: {
      "/api": { target: process.env.SMITHERS_DEV_BACKEND_ORIGIN, changeOrigin: true, ws: true },
      "/readyz": process.env.SMITHERS_DEV_BACKEND_ORIGIN
    }
  } : undefined,
  plugins: [react(), buildStamp(), entryChunkGuard(), {
    name: "smithers-sqlite-worker",
    enforce: "pre",
    // The package's prebuilt worker embeds WASM as a 1.5 MB base64 string.
    // Build its shipped source so Vite emits a small worker and a cacheable
    // WASM file instead of parsing that string on every cold database open.
    resolveId(source, importer) {
      if (source === "./opfs-worker.js" && importer?.endsWith("/browser-db-sqlite-persistence/dist/esm/opfs-database.js")) {
        return `${resolve(dirname(importer), "../../src/opfs-worker.ts")}?worker`
      }
    }
  }],
  /*
   * The world editor's Milkdown adapter pulls in Vue's esm-bundler build,
   * which warns on every load that these compile-time flags were never
   * injected. These are the values Vue's own docs name for a bundled app.
   */
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false"
  },
  root: `${here}src/mainview`,
  build: {
    outDir: `${here}dist`,
    emptyOutDir: true,
    assetsInlineLimit: (filePath) => filePath.endsWith("/wa-sqlite.wasm") ? false : undefined,
    // Milkdown ships one indivisible 818 kB ESM module, now behind the World
    // editor's dynamic import. Keep warnings meaningful for every other chunk.
    // Natural async boundaries preserve dependency evaluation order. Do not
    // suppress size warnings by fracturing shared vendor initialization graphs.
    chunkSizeWarningLimit: 900
  }
})
