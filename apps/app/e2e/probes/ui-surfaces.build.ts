import { fileURLToPath } from "node:url"
import { fixturePlugins } from "./fixturePlugins"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../../src/mainview/cards/fixtures/UiSurfacesBrowser.ts", import.meta.url))],
  target: "browser", define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: fixturePlugins
})
if (!build.success) throw new AggregateError(build.logs, "UI surfaces fixture did not build")
await Bun.write(Bun.stdout, build.outputs[0]!)
