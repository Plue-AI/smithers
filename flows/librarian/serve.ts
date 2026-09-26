/** Standalone 1.0 product gateway, staged by the authenticated workspace provisioner. */
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { packageVersion } from "../../packages/smithers/src/Version.ts"
import { layer } from "./host.ts"
import { configured, fromEnvironment } from "./seats.ts"
import * as LibrarianState from "./state.ts"
const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    root: { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "7331" },
    listen: { type: "boolean", default: false },
    "state-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" }
  }
})
if (parsed.values.version) console.log(packageVersion)
else if (parsed.values.help) {
  console.log(
    "smithers-product-host serve --root <workspace> --state-dir <state> --host <host> --port <port> --listen\nRequires SMITHERS_API_KEY, SMITHERS_GATEWAY_ID, SMITHERS_REPO, SMITHERS_FLOW_ARTIFACT_SHA256, SMITHERS_SOURCE_REVISION, SMITHERS_OWNER_GENERATION."
  )
} else {
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "serve") throw new Error("Expected serve command")
  const seats = fromEnvironment(process.env)
  configured(seats)
  const root = resolve(parsed.values.root ?? process.cwd())
  const stateRoot = LibrarianState.resolveStateRoot({
    root,
    explicit: parsed.values["state-dir"],
    environment: process.env
  })
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const port = Number(parsed.values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port")
  const credential = process.env.SMITHERS_API_KEY ?? ""
  const bind = { host: parsed.values.host, port, listen: parsed.values.listen, credential }
  const refusal = Serve.refuse(bind)
  if (refusal) throw refusal
  const repo = process.env.SMITHERS_REPO ?? ""
  // Git subprocesses must never inherit the gateway operator credential.
  delete process.env.SMITHERS_API_KEY
  const artifactDigest = createHash("sha256").update(await readFile(process.argv[1]!)).digest("hex")
  if (process.env.SMITHERS_FLOW_ARTIFACT_SHA256 !== artifactDigest) {
    throw new Error("SMITHERS_FLOW_ARTIFACT_SHA256 does not match the packaged host")
  }
  const ownerGeneration = Number(process.env.SMITHERS_OWNER_GENERATION ?? "")
  if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration <= 0) {
    throw new Error("SMITHERS_OWNER_GENERATION must be a positive safe integer")
  }
  const sourceRevision = process.env.SMITHERS_SOURCE_REVISION ?? ""
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error("SMITHERS_SOURCE_REVISION must be an immutable 40-character revision")
  }
  const options = {
    ...seats,
    root,
    stateRoot,
    repo,
    credential,
    gatewayId: process.env.SMITHERS_GATEWAY_ID ?? "",
    artifactDigest,
    sourceRevision,
    ownerGeneration
  }
  if ("Bun" in globalThis) {
    const [{ platform }, runtime] = await Promise.all([
      import("../../packages/smithers/src/internal/BunControl.ts"),
      import("@effect/platform-bun/BunRuntime")
    ])
    runtime.runMain(Serve.host(bind, root).pipe(Effect.provide(layer(platform, options))))
  } else {
    const [{ platform }, runtime] = await Promise.all([
      import("../../packages/smithers/src/internal/NodeControlHost.ts"),
      import("@effect/platform-node/NodeRuntime")
    ])
    runtime.runMain(Serve.host(bind, root).pipe(Effect.provide(layer(platform, options))))
  }
}
