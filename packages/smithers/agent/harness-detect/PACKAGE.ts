import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/agent/harness-detect"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "credential-values-never-surface",
      title: "Detection reports credential presence and names, never secret values",
      threat: "Any UI, log, or wire consumer of the Harness table reads this user's API keys or OAuth tokens.",
      lookFor: [
        "An `account` label, email, or version field built from an env var's value instead of its name (firstEnv must return the name).",
        "A value from auth.json, .credentials.json, oauth_creds.json, secrets.json, or opencode auth.json copied into the returned Harness row.",
        "decodeJwtClaims returning or logging the raw token, or a claim other than email copied into the row."
      ],
      paths: ["src/Detectors.ts", "src/Detect.ts", "src/internal/Read.ts"]
    },
    {
      id: "probe-env-allowlist",
      title: "Version probes see only PROBE_ENV_KEYS plus NO_COLOR; model-list probes add only their listCredentials",
      threat:
        "A harness CLI spawned only for --version or model listing receives Smithers Cloud, GitHub, or other session tokens from the caller's environment.",
      lookFor: [
        "probeEnv copying keys outside PROBE_ENV_KEYS, or spreading the source env.",
        "A token-bearing key (SMITHERS_CLOUD_TOKEN, GITHUB_TOKEN, AWS_*, *_SESSION) added to PROBE_ENV_KEYS.",
        "A provider API key in PROBE_ENV_KEYS, or a listCredentials key that the harness's model listing does not read.",
        "A relative PATH entry left in the probe env."
      ],
      paths: ["src/Probe.ts", "src/Detectors.ts"]
    },
    {
      id: "binary-resolution-hijack",
      title: "findBinary resolves only absolute, user- or system-owned directories",
      threat:
        "A malicious repository or writable directory plants a fake `claude`/`codex` that the app then launches with the user's credentials.",
      lookFor: [
        "A relative PATH entry (for example `.` or `node_modules/.bin`) joined without rejecting non-absolute dirs, so resolution depends on the process cwd.",
        "A candidate dir derived from an env var or repository content rather than host.home or a fixed system prefix.",
        "The nvm directory listing trusting an entry name that contains path separators or `..`.",
        "On win32, a `.cmd`/`.bat` shim returned as the binary so a later argv (model id) passes through cmd.exe metacharacter parsing."
      ],
      paths: ["src/HarnessHost.ts"]
    },
    {
      id: "env-dir-override-scope",
      title: "Env-overridden config dirs are read-only lookups of fixed credential file names",
      threat:
        "A caller-supplied CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_DIR, KIMI_SHARE_DIR, or XDG_CONFIG_HOME makes detection read an arbitrary file and surface its strings as an account label.",
      lookFor: [
        "envDir output joined with anything other than a fixed credential file name.",
        "Content of a file read via an env-overridden dir returned beyond a boolean, an email, or an organization label.",
        "An account label taken from file content (emailAddress, organizationName, google_accounts.json `active`) without a length or shape bound."
      ],
      paths: ["src/Detectors.ts", "src/internal/Read.ts"]
    },
    {
      id: "untrusted-json-parse",
      title: "Hostile credential or config JSON cannot crash detection or mutate shared objects",
      threat:
        "A crafted auth.json, providers.json, or JWT payload on this machine throws out of detectHarnessesWith or pollutes Object.prototype in the host app.",
      lookFor: [
        "Parsed objects merged, spread, or Object.assign-ed into a shared object where a `__proto__` key could mutate prototypes.",
        "hasNonEmptyStringDeep or another walker over parsed JSON losing its depth bound.",
        "JSON.parse or base64url decode outside a try/catch, or a signal that dereferences a parsed field without a type guard."
      ],
      paths: ["src/internal/Read.ts", "src/Detectors.ts"]
    },
    {
      id: "launch-argv-fixed",
      title: "Launch and model-list argv are fixed literals, never built from host data",
      threat:
        "A value from env or a config file injects extra flags or a different binary into the argv the app spawns.",
      lookFor: [
        "A `launch`, `models.list`, or `models.flag` entry derived from host.env, file content, or a parsed model id.",
        "harnessModelSpec returning a binary other than the detector's literal `binary`."
      ],
      paths: ["src/Detectors.ts", "src/Detect.ts"]
    },
    {
      id: "probe-output-bounded",
      title: "A probed binary's output reaches the Harness row only as a bounded, control-free version string",
      threat:
        "A planted or compromised CLI prints ANSI escapes or megabytes on --version, and the app's TUI or UI renders it as the version field.",
      lookFor: [
        "parseVersionLine returning the raw first line (no version match) without stripping control characters or capping its length.",
        "Detect.ts copying host.version output into the row without passing it through parseVersionLine."
      ],
      paths: ["src/Probe.ts", "src/Detect.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
