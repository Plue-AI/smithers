/**
 * Targets for the runnable example suite.
 *
 * The examples are documentation as much as code, and their tests are what keep
 * them runnable. `pnpm run check` and `pnpm test` used to reach this workspace
 * only through the recursive root scripts; these targets are the same gates as
 * declarations, planned and run by label.
 *
 * The suite stays on the Node lane: Bun's `node:sqlite` binds the host SQLite,
 * built without extension loading, which the sqlite layer the examples run on
 * requires (the same exclusion `Smithers.BunSuite` records for the storage
 * packages).
 */
import { Smithers } from "@smthrs/targets"

const cwd = "examples"

/** The example programs and the tests that keep them runnable. */
const sources = Smithers.glob("//examples/src/**/*.ts")
const tests = Smithers.glob("//examples/test/**/*.ts")

/**
 * The example projects examples 16 and 24 discover flows in.
 *
 * `<root>/flows/**` is read off disk at run time rather than imported, so the
 * markdown descriptors are declared inputs of their own. The module descriptor
 * beside them is already a `src/**\/*.ts` source.
 */
const fixtures = Smithers.glob("//examples/src/**/*.mdx")

/**
 * Checks the examples and their tests against the workspace tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [sources, tests],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * Runs every example's vitest suite.
 *
 * @since 0.1.0
 * @category test
 */
const suite = Smithers.Vitest({
  tests: [tests],
  sources: [sources, fixtures],
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

/**
 * Runs the offline burndown pacer's `node:test` suite under Node's own runner,
 * the command PACER.md documents. The suite spawns `pacer.mjs` and the
 * `burndown.sh` tick loop, so the whole directory is its input.
 *
 * @since 0.1.0
 * @category test
 */
const pacer = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//examples/burndown/pacer.test.mjs")]),
  srcs: [Smithers.glob("//examples/burndown/**")],
  deps: [],
  cwd
})

/**
 * The examples as documentation: every program and the flow descriptors
 * beside them, named as one target so the site's example pages
 * (`//apps/site:examplesPages`) can list this group in `data`. A glob
 * declared in apps/site never expands into this package, so the group is the
 * edge that makes a page regenerate when its example changes.
 */
const docs = Smithers.Filegroup({ srcs: [sources, tests, fixtures], cwd })

/**
 * Security review of the examples: users copy these programs, so a leak or an
 * unguarded listener here becomes one in every project built from them.
 *
 * @since 0.1.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "test/**", "vitest.config.ts", "README.md"],
  checks: [
    {
      id: "control-server-auth",
      title: "The example control server authenticates every HTTP and WebSocket call",
      threat: "A local process or a web page in the user's browser plans, approves, or launches flows on the example control plane.",
      lookFor: [
        "The bearer credential in serve() not drawn from randomBytes(32), or reused, logged, or returned in Summary.",
        "The Host/Origin middleware running after routing or the WebSocket upgrade, or accepting a mismatched Origin.",
        "NodeHttpServer.layer bound to anything other than 127.0.0.1, or a route mounted outside ControlRpcs.layerBearerAuth."
      ],
      paths: ["src/24-control-plane-and-gateway.ts", "src/24-project/**", "test/24-*.test.ts"]
    },
    {
      id: "scratch-fs-confinement",
      title: "Agent file tools reach only the scratch root",
      threat: "A prompt-injected or scripted model cell reads or overwrites host files outside the scratch directory.",
      lookFor: [
        "A confinedFileSystem method that calls host.* without passing the name through resolve().",
        "resolve() accepting an absolute path, a '..' segment, a NUL byte, a symlink component, or a hard-linked file.",
        "confinedFileSystem accepting, on POSIX, a root another user owns or whose mode grants any group or other permission (mode & 0o077).",
        "Read/Write FlowBinding capabilities or effects wider than `${canonicalRoot}/**`, or a capabilityEnvelope without that resource."
      ],
      paths: ["src/25-agent-tools-in-sandbox.ts", "test/25-*.test.ts"]
    },
    {
      id: "provider-key-handling",
      title: "Provider API keys come only from the environment and stay redacted",
      threat: "A user running a live smoke example leaks their OpenAI, Gemini, or other provider key into logs, argv, the journal, or a test report.",
      lookFor: [
        "An API key accepted as a positional argument, hardcoded, or read from process.env at module load.",
        "A key passed to a route or header without Redacted.make, or printed in an error or console line.",
        "A live smoke test that runs without an explicit opt-in because vitest.config.ts masks only OPENAI_API_KEY."
      ],
      paths: [
        "src/12-agent-live-smoke.ts",
        "src/13-agent-live-smoke-local.ts",
        "src/14-agent-live-smoke-gemini.ts",
        "src/15-model-layer-smoke.ts",
        "test/12-*.test.ts",
        "test/13-*.test.ts",
        "test/15-*.test.ts",
        "test/fixtures/live-test-selection.ts",
        "vitest.config.ts",
        "README.md"
      ]
    },
    {
      id: "process-containment-scope",
      title: "Spawned processes run with the narrowest capability and are reaped",
      threat: "A copied example grants flows unrestricted process spawn on the host or leaves orphaned process groups running after a crash.",
      lookFor: [
        "A Capability.Permission.Rule allowing proc:spawn with resource '*' in an engine that registers flows other than the fixed sleep/containment demos of examples 19 and 37.",
        "An MCP tool re-declared under a host grant wider than proc:spawn:mcp/<serverName>, or an MCP server command built from payload text.",
        "A child spawned with a shell string built from payload or argv values.",
        "A sandbox session root or collectDiff result applied to the host workspace without the caller deciding.",
        "A spawned child with no acquireRelease finalizer or ProcessLedger record."
      ],
      paths: [
        "src/08-host-adapters.ts",
        "src/19-cancel-and-child-cleanup.ts",
        "src/22-mcp-tools.ts",
        "src/37-host-containment.ts",
        "src/37-host-containment-host.ts",
        "src/40-sandbox-placement.ts",
        "src/41-sandboxed-flow.ts",
        "src/sandboxed-child.ts"
      ]
    },
    {
      id: "fixture-servers-loopback",
      title: "Example fixture servers bind loopback and survive malformed input",
      threat: "A host on the network reads or poisons the example action cache, or one malformed request crashes the fixture mid-run.",
      lookFor: [
        "server.listen or a telemetry baseUrl bound to a non-loopback address.",
        "decodeURIComponent or JSON.parse on request input with no try/catch in a request or line handler.",
        "A PUT /ac/{key} accepted without a body size limit."
      ],
      paths: ["src/35-remote-cache.ts", "src/22-mcp-server.ts", "src/22-mcp-tools.ts", "src/10-telemetry-export.ts"]
    },
    {
      id: "agent-prompt-payload",
      title: "Payload text in agent prompts cannot widen the tools a cell may call",
      threat: "A flow caller injects instructions through a prompt-interpolated payload field and makes the agent call tools beyond its declared envelope.",
      lookFor: [
        "An AgentAction prompt interpolating payload text while the host exposes flows beyond those the example needs.",
        "A scripted model that splices prompt text into cell code without JSON.stringify.",
        "Budget.layerUnbounded or QuotaPolicy.layerUnclassified used in an example that reaches a real provider."
      ],
      paths: ["src/11-agent-step.ts", "src/25-agent-tools-in-sandbox.ts", "src/39-agent-policies.ts", "src/33-delegation-trellis.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, suite, pacer, docs, ...securityReview }
})
