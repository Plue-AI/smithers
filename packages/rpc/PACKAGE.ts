/**
 * Targets for the shared agent contract: the typecheck and the unit suite.
 *
 * Both apps import this package. The suite uses the same Vitest runner and
 * test directory convention as the other contract packages.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/rpc"

/** The contract sources both apps import. */
const sources = Smithers.glob("//packages/rpc/src/**/*.ts")

/**
 * plue's failure registry as this package vendors it, plus the script that
 * refreshes it. Declared as sources so a refreshed artifact invalidates the
 * suite that checks it: the drift test reads the JSON off disk and imports the
 * script's digest function, neither of which the `*.ts` glob above sees.
 */
const failureCodes = [
  Smithers.glob("//packages/rpc/src/plue-failure-codes.json"),
  Smithers.glob("//packages/rpc/scripts/*.mjs")
]

/**
 * Checks the contract against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts"), ...failureCodes],
  deps: [],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite: everything under `test/`.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [sources, ...failureCodes],
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

const lint = Smithers.EsLint({
  sources: [sources],
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.jsdoc.js")],
  deps: [],
  maxWarnings: 0,
  fix: false,
  cwd
})
const fmt = Smithers.Dprint({
  sources: [Smithers.glob("**/*.{ts,json,md,js}")],
  config: Smithers.file("dprint.json"),
  deps: [],
  fix: false,
  cwd
})

/**
 * Security review of the wire contracts and the few runtime guards this
 * package ships: the browser tool's SSRF guard, model-credential origin
 * pinning, deployment origin policy, local-session capabilities, the agent
 * context prompt, card URLs, and the failure-code generator.
 *
 * @since 1.0.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "scripts/**"],
  checks: [
    {
      id: "browser-fetch-ssrf",
      title: "The browser tool reads only public https hosts, pinned after DNS, on every hop",
      threat: "A model or chat user makes the host fetch cloud metadata, loopback services, or the private network and returns their contents.",
      lookFor: [
        "An IPv4, IPv6, IPv4-mapped, 6to4 (2002::/16), Teredo (2001::/32) or NAT64 form that isPublicAddress accepts but that routes to a private or loopback host.",
        "A redirect Location followed without re-running guardTarget and re-pinning the resolved address.",
        "A fetchImpl path that resolves the hostname again instead of connecting to the guarded address (DNS rebinding).",
        "A hostname with a trailing dot or alternate spelling (localhost., 0x7f.1) that skips isBlockedHostname and reaches a private address."
      ],
      paths: ["src/BrowserFetch.ts"]
    },
    {
      id: "browser-fetch-bounds",
      title: "One browser fetch is bounded in time, bytes, redirects and parse work",
      threat: "A hostile page ties up the Worker or host with an endless body, a redirect loop, or HTML that makes text extraction quadratic.",
      lookFor: [
        "A body read, DNS query or redirect hop not covered by the shared AbortSignal deadline.",
        "readCapped buffering more than BROWSER_FETCH_MAX_BYTES before it stops.",
        "An extractReadableText or frameability loop that rescans from an unmatched opener on each iteration."
      ],
      paths: ["src/BrowserFetch.ts"]
    },
    {
      id: "model-credential-origin-pinning",
      title: "A model credential travels only to its pinned origin over https or loopback http",
      threat: "A user or operator config sends a provider API key to an attacker origin or in cleartext across the network.",
      lookFor: [
        "modelOriginOf or isLoopbackHost admitting plain http to a non-loopback host.",
        "A custom SMITHERS_MODEL_KEY_<NAME>_ORIGIN pair that can re-pin a built-in credential name.",
        "A ConfiguredModel baseUrl or path whose origin is not checked against the credential's origins before use."
      ],
      paths: ["src/ConfiguredModel.ts"]
    },
    {
      id: "secret-free-wire",
      title: "No response, listing, receipt or persisted pending record carries a secret value",
      threat: "A renderer script, log reader or browser storage reader obtains an API key, bearer, owner token or journal capability.",
      lookFor: [
        "A response or listing schema (ModelCredentialListing, ModelCredentialResult, ModelCredentialPending, cloud session answer) that admits a value or token field.",
        "A .passthrough() or loose object on a reply schema that lets unknown secret fields reach the renderer.",
        "A failure constructor that copies a caught exception or provider body into user-visible text."
      ],
      paths: [
        "src/ConfiguredModel.ts",
        "src/ApplicationAuth.ts",
        "src/ApplicationTarget.ts",
        "src/CloudTunnel.ts",
        "src/AgentTurnJournal.ts",
        "src/Refusal.ts",
        "src/RefusalCopy.ts"
      ]
    },
    {
      id: "application-target-origin-policy",
      title: "Deployment targets refuse cross-origin API use unless explicitly opted in with token auth",
      threat: "A malicious deployment document or page origin points the app's credentialed requests at another origin.",
      lookFor: [
        "normalizedOrigin accepting a non-HTTP(S) scheme, userinfo, a path, a query or a fragment.",
        "resolveApplicationTarget allowing credentialed CORS or session auth to an external origin.",
        "An owner-backend mode accepting Plue bearer auth."
      ],
      paths: ["src/ApplicationTarget.ts"]
    },
    {
      id: "local-session-capability",
      title: "Local-origin and journal capabilities are unguessable and never ride a URL",
      threat: "A web page or local process on the machine drives the local Smithers host or reads another run's turn journal.",
      lookFor: [
        "A token format shorter than 256 bits or a validator regex that admits non-base64url or shorter values.",
        "A route contract that carries the local session token or journal read token in a query string.",
        "A WebSocket route that authorizes without the local-session subprotocol."
      ],
      paths: ["src/LocalSession.ts", "src/CloudTunnel.ts", "src/AgentTurnJournal.ts", "src/AgentApiRoutes.ts"]
    },
    {
      id: "agent-context-prompt-injection",
      title: "Untrusted text in the agent context cannot pose as system instructions",
      threat: "A repository, wiki note, card title or fetched page author steers the agent into tool calls the user did not ask for.",
      lookFor: [
        "A wiki note body, repo name, card title or setup step prompt interpolated without the line() newline fold or the quoted `|` prefix.",
        "Fetched page text or upstream prose placed in the prompt without a label marking it as untrusted data."
      ],
      paths: ["src/AgentContext.ts", "src/AgentRoles.ts", "src/UpstreamProse.ts", "src/NativeAgent.ts"]
    },
    {
      id: "card-url-schemes",
      title: "URLs carried on cards and homepages are http(s) or relative before a renderer links them",
      threat: "A repository or upstream author puts a javascript: or data: URL on a card that runs script in the app origin when clicked.",
      lookFor: [
        "A url, htmlUrl, avatarUrl, iconUrl, installUrl or streamUrl field typed z.string() with no scheme refinement.",
        "A link schema in RepositoryHome or AppLinks that accepts a scheme other than http or https.",
        "MythicalIssueSchema.url or MythicalPullRequestSchema.url typed bare z.string() and rendered as an issue or pull request link.",
        "CloudAuthStartResponseSchema.url typed bare z.string() so a hostile or spoofed backend answer opens a non-https sign-in URL."
      ],
      paths: [
        "src/Cards.ts",
        "src/SubagentCard.ts",
        "src/RepositoryHome.ts",
        "src/AppLinks.ts",
        "src/Mythical.ts",
        "src/CloudTunnel.ts"
      ]
    },
    {
      id: "lsp-root-confinement",
      title: "Code-intelligence paths stay inside the repository root and leak no host paths",
      threat: "A renderer script or language server output reads files outside the repository or learns the user's home directory layout.",
      lookFor: [
        "relativeToRoot accepting a target whose decoded segments contain .., ., empty, %2F, backslash or NUL, or a file:// authority different from the root's.",
        "redactHostPaths leaving an absolute path or file:// URI of the host visible in hover or diagnostic text.",
        "A request schema (LspFileRequestSchema, LspPositionRequestSchema) documented as root-relative whose path field admits an absolute path with no host-side segment check named."
      ],
      paths: ["src/LspWire.ts", "src/LocalLsp.ts"]
    },
    {
      id: "failure-codes-codegen",
      title: "The failure-code generator emits only data, never code, from its source document",
      threat: "Whoever controls a --from URL or file, or the canonical failure-codes.json, injects TypeScript that runs in every app build and test.",
      lookFor: [
        "A document field (status, retry_after, fault, code, doc) interpolated into generated TypeScript without JSON.stringify or a numeric type check.",
        "A --from source fetched over plain http or trusted solely by a digest the same document supplies."
      ],
      paths: ["scripts/refresh-failure-codes.mjs", "src/PlueFailureCodes.ts"]
    }
  ]
})

/**
 * Build, lint, formatting, and test gates for the public wire contracts.
 *
 * @since 1.0.0
 * @category packages
 */
export const Package = Smithers.Package({
  targets: { check, unitTests, lint, fmt, ...securityReview }
})
