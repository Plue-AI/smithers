/**
 * Targets for the UI application: typecheck, unit suite and browser tier.
 *
 * Playwright T1 runs in the dedicated PR browser job. Packaged Electrobun
 * remains a separate operator tier; see docs/LOCAL-APP.md "Test tiers".
 *
 * The unit suite uses the declared Bun runtime. SDK preparation and typecheck
 * use the workspace's Node runtime and package manager.
 */
import { Smithers } from "@smthrs/targets"
import { Package as rpcPackage } from "../../packages/rpc/PACKAGE.ts"
import { Package as harnessDetectPackage } from "../../packages/smithers/agent/harness-detect/PACKAGE.ts"
import { Package as gatewayPackage } from "../../packages/smithers/gateway/PACKAGE.ts"
import { Package as componentPackage } from "../../packages/smithers/ui/PACKAGE.ts"

const cwd = "apps/app"

/** The application sources every suite drives. */
const sources = Smithers.glob("//apps/app/src/**/*.ts")

/** The React components, part of the typecheck's and unit suite's key material. */
const componentSources = Smithers.glob("//apps/app/src/**/*.tsx")

/** The stylesheets the SPA bundles; a CSS-only change must invalidate the unit cache too. */
const styleSources = Smithers.glob("//apps/app/src/**/*.css")

/** The build/runtime configs the bundler reads. */
const buildConfigs = [
  Smithers.file("vite.config.ts"),
  Smithers.file("tailwind.config.js"),
  Smithers.file("postcss.config.js")
]

/**
 * The harness and suite sources outside `src/`. The tsconfig compiles them, so
 * the typecheck measures them and its key has to carry them too.
 */
const harnessSources = Smithers.glob("//apps/app/scripts/**/*")

/** The lint sources outside `src/`: the literal pin and the vocabularies it derives. */
const lintSources = Smithers.glob("//apps/app/lint/**/*")
const suiteSources = Smithers.glob("//apps/app/e2e/**/*")

/** The assertion contracts the e2e tiers share; pure, so the unit suite gates them. */
const contractSources = Smithers.glob("//apps/app/e2e/contracts/**/*.ts")

/**
 * Projects the pinned Electrobun SDK before a fresh checkout can typecheck.
 * CI installs with scripts disabled, and the SDK is generated outside the
 * build cache, so this prerequisite always checks the local projection.
 *
 * @since 1.0.0-rc.0
 * @category build
 */
const devkit = Smithers.NodeBinary({
  entry: Smithers.file("scripts/ensure-devkit.mjs"),
  args: [],
  srcs: [
    Smithers.file("package.json"),
    Smithers.file("electrobun.config.ts"),
    Smithers.file("hutch.config.ts"),
    Smithers.file("//pnpm-lock.yaml")
  ],
  deps: [],
  env: { HUTCH_NO_UPDATE_CHECK: "1" },
  cwd,
  // The Hutch and Electrobun release hosts, and GitHub's release asset hosts
  // their downloads redirect to.
  destinations: [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "hutch.blackboard.sh",
    "electrobun-artifacts.blackboard.sh"
  ]
})

/**
 * Checks the application against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  /*
   * Everything this tsconfig includes: `scripts`, `e2e`, `lint`, and the
   * bundler and Electrobun configs are compiled by this target, so a key made of `src`
   * alone would serve a green cache entry over an edit that breaks the
   * typecheck.
   */
  srcs: [
    sources,
    componentSources,
    harnessSources,
    suiteSources,
    lintSources,
    ...buildConfigs,
    Smithers.file("electrobun.config.ts"),
    Smithers.file("hutch.config.ts"),
    Smithers.file("playwright.config.ts"),
    Smithers.file("playwright.showcase.config.ts")
  ],
  deps: [devkit],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite: everything under `src/`, the e2e assertion contracts under
 * `e2e/contracts/` and the script contracts under `scripts/`, hermetic, with no
 * server and no browser.
 *
 * @since 0.1.0
 * @category test
 */
// Coverage policy: assertion-only for Bun UI units, with required offline
// Playwright in browserE2e. No source coverage percentage is claimed; see
// scripts/repo-contract/README.md for the denominator exception.
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["src", "e2e/contracts", "e2e/real/coverage", "e2e/real/support", "e2e/real/auth-permissions/profile.test.ts", "scripts"]),
  // 6,740 tests across 520 files took 813s on a clean 2026-09-29 checkout;
  // the shared 600s default killed CI while Bun was still running tests.
  timeout: "20m",
  srcs: [
    sources,
    componentSources,
    styleSources,
    contractSources,
    harnessSources,
    suiteSources,
    ...buildConfigs,
    Smithers.glob("//apps/app/*.ts"),
    Smithers.file("tsconfig.json"),
    Smithers.file("package.json"),
    Smithers.file("bunfig.toml"),
    Smithers.file("//package.json"),
    Smithers.file("//pnpm-lock.yaml"),
    Smithers.file("//scripts/require-toolchain.mjs"),
    Smithers.file("//packages/backend/internal/compose/bootstrap.go"),
    Smithers.file("//packages/rpc/fixtures/force/graph.json"),
    Smithers.file("//packages/rpc/fixtures/force/plan-typeCheck.json")
  ],
  // Globs cannot cross PACKAGE.ts boundaries; dependency keys carry these sources.
  deps: [rpcPackage.check, componentPackage.check, gatewayPackage.check, harnessDetectPackage.check],
  cwd
})

/**
 * The conformance lint: the literal pin under `lint/conformance/`.
 *
 * It is a lint, not a unit suite. It derives the app's vocabularies — flow
 * names, card kinds, card-id prefixes, emitted `data-*` attributes — from
 * product source and the running store, then refuses any literal the e2e
 * suites and the `scripts/` runners assert against that no longer resolves.
 * Because it reads harnesses, configuration and workspace vocabularies by
 * path, its key carries every tree it scans; discovery paths alone do not
 * contribute to a target's input identity.
 *
 * @since 1.0.0
 * @category lint
 */
const conformance = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["lint/conformance"]),
  srcs: [
    sources,
    componentSources,
    styleSources,
    contractSources,
    harnessSources,
    suiteSources,
    lintSources,
    ...buildConfigs,
    Smithers.glob("//apps/app/*.ts"),
    Smithers.file("tsconfig.json"),
    Smithers.file("package.json"),
    Smithers.file("bunfig.toml"),
    Smithers.file("//package.json"),
    Smithers.file("//pnpm-lock.yaml"),
    Smithers.file("//scripts/require-toolchain.mjs"),
    Smithers.file("//packages/backend/internal/services/issue_sync.go")
  ],
  // Globs cannot cross PACKAGE.ts boundaries; dependency keys carry these sources.
  deps: [rpcPackage.check, componentPackage.check, gatewayPackage.check, harnessDetectPackage.check],
  cwd
})

/**
 * Runs pinned Playwright and Bun browser OAuth tests, with no live provider
 * calls, the built smithers.sh landing and its AppIsland (e2e/site), and the
 * flow-graph tier: the app over a real control plane and a real engine on
 * localhost, with nothing intercepted (e2e/graph/README.md). The steps run
 * serially (scripts/run-pr-e2e.mjs says why) in ~22 min on ubuntu-latest;
 * 30m keeps 30% headroom inside the apps-e2e job's 70.
 *
 * Exclusive: wildcard `test` and `ci` selections omit it, and CI's apps-e2e
 * job names it by label.
 */
const browserE2e = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("scripts/run-pr-e2e.mjs")),
  timeout: "30m",
  srcs: [sources, componentSources, styleSources, harnessSources, suiteSources, ...buildConfigs,
    Smithers.file("playwright.config.ts"), Smithers.file("playwright.site.config.ts"), Smithers.file("playwright.graph.config.ts"),
    Smithers.file("playwright.showcase.config.ts"), Smithers.file("package.json"), Smithers.file("//pnpm-lock.yaml"),
    // `bun test` steps preload the toolchain floor.
    Smithers.file("bunfig.toml"), Smithers.file("//package.json"), Smithers.file("//scripts/require-toolchain.mjs")],
  deps: [],
  env: { SMITHERS_CHAT_STUB: "1" },
  exclusive: true,
  cwd
})

/**
 * Everything a web host needs to bundle the app as a React island: the
 * mainview tree (AppIsland.tsx and the CSS it imports), the Tailwind config
 * index.css names, the build stamp both builds share, and package.json for
 * the pinned react version. apps/site's build target lists it as an input so
 * the site rebuilds when the app changes.
 *
 * @since 1.0.0
 * @category build
 */
const webSources = Smithers.Filegroup({
  srcs: [
    Smithers.glob("src/mainview/**/*"),
    Smithers.file("tailwind.config.js"),
    Smithers.file("scripts/build-stamp.ts"),
    Smithers.file("package.json")
  ],
  cwd
})

/** Complete React source input for the reproducible Solid projection. */
const solidCodegenInputs = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*"), Smithers.file("package.json")],
  cwd
})

/**
 * Security review of the desktop host, the renderer and the packaging scripts.
 * `security` reviews the diff against origin/main; `securityAudit` reviews all
 * of `include`. The e2e tree (with its nested fixture packages) is left out.
 *
 * @since 1.0.0
 * @category lint
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "scripts/**", "electrobun.config.ts"],
  checks: [
    {
      id: "loopback-origin-gate",
      title: "Every loopback server refuses foreign Host and Origin before relaying or acting",
      threat: "A web page the user visits (cross-origin or via DNS rebinding) drives the local app's API with the user's session cookie, bearer or cloud token.",
      lookFor: [
        "A Bun.serve handler that relays /api/* without comparing the Host header to its own 127.0.0.1:<port>.",
        "A state-changing /api/* route that runs without the local session header or an Origin match.",
        "A renderer relay that exposes a readable __csrf cookie to any origin that reaches the port.",
        "A WebSocket upgrade accepted when Origin is absent or differs from the served origin."
      ],
      paths: ["src/bun/server.ts", "src/bun/NativeRendererServer.ts", "src/bun/CloudAuth.ts", "src/bun/PackagedE2EBridge.ts"]
    },
    {
      id: "relay-credential-scope",
      title: "Relayed requests carry only the selected backend's credential to that backend",
      threat: "A renderer path or a switched backend target receives another backend's bearer, cookie jar or CSRF token.",
      lookFor: [
        "A proxied request whose target URL can leave the selected upstream origin (dot segments, encoded slashes, absolute paths).",
        "An Authorization, Cookie or x-csrf-token header forwarded without being rebuilt for the current target.",
        "A cookie jar, bearer or in-flight stream that survives setTarget or a backend generation change.",
        "A redirect followed by fetch that resends the bearer to another origin."
      ],
      paths: ["src/bun/NativeRendererServer.ts", "src/bun/server.ts"]
    },
    {
      id: "native-rpc-authority",
      title: "Native RPC requests the renderer can call are validated in the Bun process",
      threat: "Script running in the WebView (an XSS or a loaded remote page) reads tokens, re-points the backend at an attacker host, or opens non-http schemes.",
      lookFor: [
        "switchApplicationTarget accepting an origin that is not an allowlisted or user-confirmed backend.",
        "applicationToken or applicationBootstrapToken answered to a page whose URL is not the local renderer origin.",
        "openExternal passing a scheme other than http(s) to the OS.",
        "The window or a deep link navigating to a URL outside the renderer origin while the RPC bridge stays attached."
      ],
      paths: ["src/bun/NativeApp.ts", "src/bun/NativeApiOrigin.ts", "src/bun/DeepLink.ts", "src/mainview/native/**"]
    },
    {
      id: "cloud-login-callback",
      title: "The CLI sign-in callback accepts exactly one credential bound to its callback_state",
      threat: "A local process or web page injects its own Smithers Cloud token so the user's work lands in an attacker account, or steals the token.",
      lookFor: [
        "A /callback POST accepted without a timing-safe callback_state match or with a foreign Origin.",
        "A second callback able to replace the first accepted token.",
        "The token written to logs, argv of `security`, or the renderer session answer.",
        "A keychain command built by string interpolation of an unchecked service or account."
      ],
      paths: ["src/bun/CloudAuth.ts", "src/bun/ModelCredentials.ts"]
    },
    {
      id: "backend-child-env",
      title: "The owned backend child gets an allowlisted environment and verified binaries",
      threat: "A shell's provider keys or cloud tokens leak into the backend and its agents, or a swapped binary runs with the owner's bootstrap token.",
      lookFor: [
        "A spawn env built from Bun.env or process.env instead of LAUNCHER_PASSTHROUGH plus explicit keys.",
        "An executable path taken from an env override that skips the checksum check.",
        "The bootstrap-token secrets file read when it is group/world readable or not a regular file.",
        "The owned backend origin allowed to be non-loopback."
      ],
      paths: ["src/bun/NativeBackendProcess.ts", "src/bun/serve.ts", "scripts/build-native.ts", "scripts/bundle-postgres.ts", "scripts/validate-git-bundle.ts"]
    },
    {
      id: "browser-fetch-ssrf",
      title: "Agent browser fetches reach only public https destinations pinned after the check",
      threat: "A prompt-injected agent turn reads loopback services, cloud metadata or the LAN through the host's fetch route.",
      lookFor: [
        "A fetch whose socket address is not the address the shared guard validated (DNS rebinding between check and connect).",
        "A redirect or decompression path with no size or destination bound.",
        "A browser.* flow that sends a non-http(s) or loopback URL to the host route instead of refusing it."
      ],
      paths: ["src/bun/BrowserFetch.ts", "src/mainview/state/controller/presentation.ts"]
    },
    {
      id: "agent-command-authority",
      title: "A model tool call executes only model-invocable commands with validated arguments",
      threat: "A prompt-injected model turn signs the user in or out, resets state, sends chat, or launches runs and writes on the user's repositories without a human gesture.",
      lookFor: [
        "A tool_call name dispatched through a path that skips the modelInvocable check in executeForAgent or the registry.",
        "A user-only flow (auth.sign-in, cloud.sign-in, admin.reset, chat.send) reachable by an alias, canonicalized name or slash payload from the agent invoker.",
        "Tool-call arguments parsed with JSON.parse and passed on without the flow's argument schema.",
        "A tool result that returns secrets, tokens or unredacted flow output to the model."
      ],
      paths: ["src/mainview/flows/agentTools.ts", "src/mainview/flows/Commands.ts", "src/mainview/flows/registry.ts", "src/mainview/state/controller/turns.ts", "src/mainview/state/HttpTurn.ts"]
    },
    {
      id: "upstream-card-frames",
      title: "Card frames from the chat upstream cannot replace owned cards or embed the app origin",
      threat: "A compromised or prompt-injected chat upstream overwrites approval or runtime cards, or plants a browser card whose frame runs script in the app origin.",
      lookFor: [
        "A card or card.update frame that upserts over an existing card id the upstream did not create.",
        "A browser card whose url or finalUrl is relative, same-origin or non-http(s) and still renders as an iframe with allow-scripts allow-same-origin.",
        "A card.update patch that changes a browser card's url or frameable flag after the host's fetch set them."
      ],
      paths: ["src/bun/CloudAgent.ts", "src/mainview/state/controller/turns.ts", "src/mainview/cards/ConversationCards.tsx"]
    },
    {
      id: "renderer-untrusted-markup",
      title: "Repository, wiki, issue and model content never becomes script or a navigable dangerous URL",
      threat: "A repository author, issue commenter or model output runs script in the app origin and steals the local session capability or cloud session.",
      lookFor: [
        "dangerouslySetInnerHTML or innerHTML fed by anything other than a static constant.",
        "href, src or window.open taking a repo, wiki, issue or card URL without an http(s) scheme check.",
        "A markdown renderer configured to pass raw HTML through."
      ],
      paths: ["src/mainview/**/*.tsx", "src/mainview/wiki/**", "src/mainview/state/seams/**"]
    },
    {
      id: "static-path-containment",
      title: "Static file serving stays inside the dist directory",
      threat: "A local page or process reads arbitrary files from the user's disk through the loopback server.",
      lookFor: [
        "A decoded path joined to distDir without a resolve plus prefix check against distDir + '/'.",
        "A symlink inside dist followed out of it."
      ],
      paths: ["src/bun/server.ts", "src/bun/NativeRendererServer.ts"]
    },
    {
      id: "journal-and-log-redaction",
      title: "Turn journals, client-error ingest and logs never persist tokens",
      threat: "Anyone with read access to the state directory or logs recovers the user's cloud or model credentials.",
      lookFor: [
        "A log line or journal record that writes a request header, env value or error text without the redactor.",
        "Journal files created without owner-only permissions."
      ],
      paths: ["src/bun/NativeTurnJournal.ts", "src/bun/TurnJournalLease.ts", "src/bun/server.ts", "src/bun/NativeBackendProcess.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { solidCodegenInputs, devkit, check, unitTests, conformance, browserE2e, webSources, ...securityReview }
})
