/** Private staged /usr/local/bin/smithers-coding-host entry for an owning Plue workspace. */
import { Effect, Layer } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { packageVersion } from "../../packages/smithers/src/Version.ts"
import { layer } from "./host.ts"
import * as Landing from "./landing.ts"
import { load as loadLanding } from "./landing-config.ts"
import { loadProject } from "./project-config.ts"
import * as CodingState from "./state.ts"
import { resolveRuntimeBridgeIdentity } from "./runtime-bridge.ts"
import { layer as checkReceiptLayer } from "../repository/check-receipt.ts"
import { remoteLayer } from "../repository/remote.ts"
import type * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"

/** Operator role→seat pins; `configured` validates each entry. */
const parseSeats = (text: string): Readonly<Record<string, string>> => {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.values(value).some(seat => typeof seat !== "string")) throw new Error("SMITHERS_CODING_SEATS must be a JSON object of role to seat")
  return value as Readonly<Record<string, string>>
}

const parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
  root: { type: "string" }, host: { type: "string", default: Serve.defaultBind.host },
  port: { type: "string", default: String(Serve.defaultBind.port) }, listen: { type: "boolean", default: false },
  credential: { type: "string" }, "state-dir": { type: "string" },
  help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }
} })
if (parsed.values.version) {
  process.stdout.write(`${packageVersion}\n`)
} else if (parsed.values.help) {
  process.stdout.write("smithers-coding-host serve --root <workspace> --host <host> --port <port> --listen [--state-dir <path>]\n" +
    `--state-dir, or ${CodingState.directoryVariable}, holds control.db and engine.db; it defaults to a sibling of the root and may never be inside it.\n` +
    `Set ${CodingState.inRootVariable}=1 only for a local single-repository run that wants the old <root>/.flows layout.\n` +
    "Requires SMITHERS_GATEWAY_ID and SMITHERS_CODING_IMPLEMENT_MODEL; SMITHERS_API_KEY authenticates the existing gateway.\n" +
    "Loads <root>/.smithers/coding-project.json when present; SMITHERS_CODING_PROJECT overrides it.\n" +
    "SMITHERS_FLOW_ARTIFACT_SHA256, SMITHERS_SOURCE_REVISION and SMITHERS_OWNER_GENERATION bind the runtime bridge.\n" +
    "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY selects the packaged native workspace helper.\n" +
    "Optional SMITHERS_CODING_PLAN_MODEL, SMITHERS_CODING_POC_MODEL and SMITHERS_CODING_WIKI_MODEL select provider:model roles.\n" +
    "The project's \"seats\" map routes roles to aliases (sol, astra, luna, opus, fable, qwen); SMITHERS_CODING_SEATS (JSON) overrides it.\n" +
    "The provisioned SMITHERS_JJHUB_TOKEN and SMITHERS_JJHUB_API_URL enable coding/vibe; the token is consumed before any tool starts.\n")
} else {
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "serve") throw new Error("This configured workspace entry accepts the existing serve command")
  const root = resolve(parsed.values.root ?? process.cwd())
  const port = Number(parsed.values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer from 0 to 65535")
  const bind: Serve.Bind = { host: parsed.values.host, port, listen: parsed.values.listen,
    credential: parsed.values.credential ?? process.env.SMITHERS_API_KEY }
  const refusal = Serve.refuse(bind)
  if (refusal) throw refusal
  // The engine writes control.db, engine.db and their WAL files on every step.
  // Inside `--root` those are untracked JJ files, so the working-copy tree
  // digest moved under each plan and coding/PreparePlan failed its own
  // freshness check with stale_revision. Resolve the state directory outside
  // the working copy and create it before any layer opens a database.
  const stateRoot = CodingState.resolveStateRoot({ root, explicit: parsed.values["state-dir"], environment: process.env })
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const runtimeBridge = await resolveRuntimeBridgeIdentity(process.argv[1]!, process.env)
  const options = { repositoryPath: root, stateRoot, credential: bind.credential, gatewayId: process.env.SMITHERS_GATEWAY_ID ?? "",
    sourcePublication: process.env.SMITHERS_CODING_LOCAL_OWNER === "1" ? "local-only" as const : "cloud" as const,
    ...runtimeBridge,
    implementationModel: process.env.SMITHERS_CODING_IMPLEMENT_MODEL ?? "",
    ...(process.env.SMITHERS_CODING_PLAN_MODEL === undefined ? {} : { planningModel: process.env.SMITHERS_CODING_PLAN_MODEL }),
    ...(process.env.SMITHERS_CODING_POC_MODEL === undefined ? {} : { pocModel: process.env.SMITHERS_CODING_POC_MODEL }),
    ...(process.env.SMITHERS_CODING_WIKI_MODEL === undefined ? {} : { wikiModel: process.env.SMITHERS_CODING_WIKI_MODEL }),
    ...(process.env.SMITHERS_CODING_SEATS === undefined ? {} : { seats: parseSeats(process.env.SMITHERS_CODING_SEATS) }),
    checkEnvironment: Object.fromEntries([
      "PATH", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
      "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"
    ].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])) }
  // The reserved repository credential leaves process.env here, before the
  // host, model seats or any approved shell tool can inherit it.
  const run = (platform: NativeControl.Platform, http: Layer.Layer<HttpClient.HttpClient>) =>
    Effect.all([loadProject(root, process.env.SMITHERS_CODING_PROJECT), loadLanding(root, process.env)]).pipe(
      Effect.flatMap(([planning, landing]) => Serve.host(bind, root).pipe(Effect.provide(layer(platform, {
        ...options, ...(planning === undefined ? {} : { planning }),
        ...(landing === undefined ? {} : {
          landing: Landing.layer(landing).pipe(Layer.provide(http), Layer.orDie),
          repositoryRemote: Layer.merge(remoteLayer({ ...landing, gatewayId: options.gatewayId, credential: options.credential ?? "" }),
            checkReceiptLayer({ ...landing, gatewayId: options.gatewayId, credential: options.credential ?? "" })).pipe(Layer.provide(http), Layer.orDie)
        })
      })))),
      Effect.provide(platform.host)
    )
  // Only the concrete platform boundary is dynamic. Policy, durable stores and
  // coding registration above are the same on Bun and Node.
  if ("Bun" in globalThis) {
    const [{ platform }, runtime, http] = await Promise.all([
      import("../../packages/smithers/src/internal/BunControl.ts"), import("@effect/platform-bun/BunRuntime"), import("@effect/platform-bun/BunHttpClient")
    ])
    runtime.runMain(run(platform, http.layer))
  } else {
    // One constructor owns "the Undici client this process should use": it
    // routes through the egress proxy the environment names and is the plain
    // pool when it names none. `platform.httpClient` is built from the same
    // one, so the client handed to landing and the remote here and the client
    // the judge dials through cannot drift apart.
    const [{ platform }, runtime, egress] = await Promise.all([
      import("../../packages/smithers/src/internal/NodeControlHost.ts"), import("@effect/platform-node/NodeRuntime"),
      import("@smthrs/platform-node/EgressHttpClient")
    ])
    runtime.runMain(run(platform, egress.layer(process.env)))
  }
}
