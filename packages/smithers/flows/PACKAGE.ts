import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/flows"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

// Nested packages (engine, kernel, sandbox, ...) own their own reviews; these
// globs reach only this barrel's src/, docs/ and scripts/.
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "scripts/**"],
  checks: [
    {
      id: "guest-result-trust",
      title: "Guest-written results and diffs are untrusted data bounded and validated before the host uses them",
      threat:
        "Code running in a sandbox guest exhausts host memory, forges a success, or smuggles host-side paths into the caller's workspace diff.",
      lookFor: [
        "A read of result.json or a changed file that is not capped by readBounded at resultBytes or the remaining diffBytes budget.",
        "A guest result accepted without the per-execution attempt nonce matching, or without decoding output through the flow's success schema.",
        "A DiffEntry.path or deleted path taken from the guest listing that can contain '..', an absolute path, or a backslash once normalized, and is returned without rejection.",
        "A symlink the guest plants in the workdir that stat follows so collect reads a guest file outside the workdir into the diff.",
        "Code or docs treating the attempt nonce as proof of honesty, although request.json holding it is readable by the guest; it only rejects stale results.",
        "A request whose capabilityCeiling is not the caller's current authority intersected with the flow's declaration, a guest that runs the child under anything wider than the ceiling it decoded, or a result accepted whose capabilityCeiling echo differs from the one sent."
      ],
      paths: ["src/SandboxedFlow.ts", "src/internal/SandboxedFlowGuest.ts"]
    },
    {
      id: "guest-command-quoting",
      title: "Session commands quote every caller- or guest-shaped word",
      threat:
        "A caller-supplied runtime or a provider workdir containing shell metacharacters runs arbitrary commands in the sandbox session.",
      lookFor: [
        "A session.spawn command string that interpolates runtime, bundlePath, workdir, or a diff path without CommandLine.quote.",
        "The head -c fallback reading a path that can begin with '-' or is not quoted as one word.",
        "Env passed to the guest spawn that carries more than SMITHERS_SANDBOX_REQUEST_PATH and SMITHERS_SANDBOX_RESULT_PATH from the host."
      ],
      paths: ["src/SandboxedFlow.ts"]
    },
    {
      id: "guest-output-redaction",
      title: "Guest stdout, stderr, and failure text is redacted before it enters an error, log, or journal",
      threat:
        "A child flow that prints an API key or PEM private key leaks it to the parent's journal, terminal, and anyone who can read run history.",
      lookFor: [
        "A SandboxedFlowError message or cause built from guest text that bypasses failure() or tail() redaction.",
        "drainTail logic where a credential split across chunks, lines, or the 4096-byte ring boundary survives unredacted in the retained tail.",
        "A PEM BEGIN marker whose body is retained when no END marker arrives before stream end.",
        "The guest's describe() quoting failure fields before RedactedLogger.redactArgument runs, or truncating before redacting."
      ],
      paths: ["src/SandboxedFlow.ts", "src/internal/SandboxedFlowGuest.ts"]
    },
    {
      id: "bundle-contents-leak",
      title: "The bundle shipped to the guest contains only the entry's code, never host secrets",
      threat:
        "A sandbox provider operator or co-tenant reads host credentials or local files that esbuild inlined into bundle.mjs.",
      lookFor: [
        "esbuild options that define process.env values, inline .env or JSON config files, or embed absolute host paths beyond the entry and runner.",
        "An entry path taken from an untrusted caller string so bundling reads an arbitrary host file into the guest bundle."
      ],
      paths: ["src/SandboxedFlow.ts"]
    },
    {
      id: "sandbox-session-isolation",
      title: "One sandbox session key is exclusive to one execution and its deadline always tears it down",
      threat:
        "One parent flow reattaches another run's sandbox machine and reads or overwrites its workspace, request, or result.",
      lookFor: [
        "A toLayer session key example or default that omits executionId or callId so two runs or two parallel calls share a machine.",
        "A path where the deadline race wins but the scoped session release does not run, leaving a reattachable machine with the payload on disk.",
        "A stale result.json from an earlier attempt that is read because files.remove failed silently."
      ],
      paths: [
        "src/SandboxedFlow.ts",
        "docs/guides/run-a-child-flow-in-a-sandbox.md",
        "docs/concepts/runner-protocol.md"
      ]
    },
    {
      id: "host-guarded-layering",
      title: "Flow bodies receive only the guarded, capability-checked host services",
      threat:
        "A flow body or agent action reads, writes, or spawns outside the workspace grants by resolving a raw host service.",
      lookFor: [
        "A raw platform.host.layerAt service tag that is provideMerge'd into the engine context and not overridden by layerContainedAt or HostServices.",
        "The privileged Jj or raw FileSystem reachable from Action implementations rather than only from EngineStore machinery.",
        "GrantStore built with attended: false and rules that default to allow when the caller passes none.",
        "Caller-supplied rules, containment, or signals used without the frozen snapshot, so the caller can widen grants after validateHost returns."
      ],
      paths: ["src/internal/NativeRuntime.ts", "src/Runtime.ts"]
    },
    {
      id: "runtime-config-secrets",
      title:
        "Runtime configuration errors and storage paths never expose DSN credentials or place engine state where flows can tamper",
      threat:
        "An operator's Postgres password leaks into an error or log, or a flow body rewrites artifact objects the engine trusts on replay.",
      lookFor: [
        "A RuntimeConfigurationError or log line that interpolates the filename or postgres:// DSN value.",
        "Runtime.storage placing the artifact store under workspaceRoot/.flows for a Postgres filename, inside the directory flow bodies may write.",
        "A SQLite filename accepted inside workspaceRoot, so engine.db and its objects directory sit where guarded flow bodies can rewrite journal or cache evidence.",
        "The mkdirSync fallback in databaseLayer creating a directory the confined filesystem refused as outside its root."
      ],
      paths: ["src/Runtime.ts", "src/internal/RuntimeOptions.ts", "src/internal/NativeRuntime.ts"]
    },
    {
      id: "docs-copyable-snippets",
      title: "Copyable docs snippets do not teach unsafe sandbox or runtime configuration",
      threat:
        "A user copying a guide ships shared session keys, applies an unreviewed guest diff to the host, or hardcodes a credential.",
      lookFor: [
        "A snippet that applies Result.diff to the host workspace without a review or path check.",
        "A snippet with a literal API key, DSN password, or token, or a session key constant across executions."
      ],
      paths: ["docs/**"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
