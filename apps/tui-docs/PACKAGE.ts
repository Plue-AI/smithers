/** Executable TUI docs: Markdown -> cached terminal recordings -> Astro site. */
import { Smithers } from "@smthrs/targets"
import { Package as tui } from "../tui/PACKAGE.ts"
import * as Docs from "./scripts/targets.ts"
const recordings = Docs.recordings(tui.docsFiles, tui.recordingSources)
const build = Docs.site(recordings, tui.docsFiles)
const securityReview = Smithers.SecurityReview({
  cwd: "apps/tui-docs",
  include: ["src/**", "server/**", "scripts/**", "astro.config.mjs"],
  checks: [
    {
      id: "sponsor-budget",
      title: "Sponsored model spend stays within the daily dollar, call, and per-visitor caps",
      threat: "An anonymous internet client drains the maintainer's OpenRouter budget or locks every other visitor out of the sponsored playground.",
      lookFor: [
        "A per-visitor limit keyed on a client-chosen value (a cookie, or a forwarded address header the operator did not name in DOCS_CLIENT_IP_HEADER) instead of the observed client address.",
        "An Origin equality check treated as authentication although non-browser clients set Origin freely.",
        "A reservation smaller than the real cost: size counted in bytes but priced as tokens, provider request fee or fallback routing not reserved, or a refund path.",
        "A request field (model, max_tokens, stream, provider, tools) copied from the client body into the upstream OpenRouter call.",
        "A cache hit or error path that skips the BEGIN IMMEDIATE reservation or leaves a transaction open."
      ],
      paths: ["server/sponsor.mjs", "server/serve.mjs"]
    },
    {
      id: "sponsor-key-exposure",
      title: "OPENROUTER_API_KEY never leaves the server",
      threat: "A playground visitor reads the sponsor's OpenRouter key and spends against it without any cap.",
      lookFor: [
        "The key or an Authorization header echoed in a response body, error message, log line, or cached SQLite row.",
        "Upstream requests that follow redirects or take a URL from the client, sending the bearer token to another host.",
        "The key or a key-bearing env var baked into the Astro bundle via import.meta.env or define."
      ],
      paths: ["server/**", "src/**", "astro.config.mjs"]
    },
    {
      id: "static-root-containment",
      title: "The docs server serves only files under DOCS_DIST",
      threat: "A remote visitor reads files outside the built site, such as the sponsor SQLite database or repository sources, from the self-hosted docs server.",
      lookFor: [
        "A decoded request path resolved against root without the root + '/' prefix check, or a check done before decodeURIComponent or directory index resolution.",
        "Symlinks under dist or the directory-to-index.html rewrite that land outside root.",
        "A default DOCS_BUDGET_DB or cache path placed inside the served dist directory."
      ],
      paths: ["server/serve.mjs"]
    },
    {
      id: "playground-sandbox",
      title: "Model-written code runs only inside the bounded QuickJS sandbox and virtual files",
      threat: "A malicious or prompt-injected model reply executes script in the visitor's page origin or escapes the two-file sandbox.",
      lookFor: [
        "Model or file content evaluated with eval, new Function, innerHTML, or a script element on the page instead of QuickJS evalCode.",
        "A QuickJS runtime without the memory limit or interrupt handler, or a host function exposed into the VM context.",
        "A sandbox file path accepted without the path() allowlist regex, or check.js writable."
      ],
      paths: ["src/playground/**", "src/components/**", "src/pages/**"]
    },
    {
      id: "personal-provider-key",
      title: "A visitor's own provider key is sent only to the HTTPS endpoint they configured",
      threat: "A visitor's personal API key is persisted in localStorage or sent to the sponsor proxy or a plaintext non-local host.",
      lookFor: [
        "settings.apiKey written to the Journal, localStorage, or an exported snapshot.",
        "An Authorization header attached on the sponsored /api/playground/model path.",
        "endpoint() accepting http for non-loopback hosts, userinfo, or a base URL that redirects (redirect not 'error')."
      ],
      paths: ["src/playground/**"]
    },
    {
      id: "recording-isolation",
      title: "Recording and browser scripts run the TUI against fixtures only, never with the host's credentials",
      threat: "A docs recording run leaks the developer's real API keys, clipboard, or home directory into a public GIF or transcript, or runs a docs-authored script outside its scratch dir.",
      lookFor: [
        "A child env that spreads process.env or forwards provider keys instead of the explicit PATH/HOME/TMPDIR allowlist.",
        "A recording id, Expect file path, or scenario name used in a filesystem path without the parseScripts or scenarioNames allowlist.",
        "Provider traffic not pinned to the local providerFixture (SMITHERS_ACCOUNT_POOL_URL) or NO_PROXY dropped.",
        "A Vite fs.allow wider than this app, packages/smithers, and node_modules, reachable from a dev server bound to a non-loopback host."
      ],
      paths: ["scripts/**", "astro.config.mjs"]
    }
  ]
})
export const Package = Smithers.Package({
  targets: {
    recordings,
    build,
    check: Docs.check(tui.docsFiles),
    test: Docs.test(tui.docsFiles),
    browserTests: Docs.browserTest(build),
    sources: Docs.sourceFiles,
    ...securityReview
  }
})
