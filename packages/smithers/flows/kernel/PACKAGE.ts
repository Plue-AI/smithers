import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/flows/kernel"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "spawn-grant-matches-execution",
      title: "The proc:spawn resource describes exactly the process that runs",
      threat: "A flow granted one command line runs a different program, arguments, or shell on the host.",
      lookFor: [
        "A command field read for the capability check and read again (getter, proxy, mutation) for the actual spawn instead of from one frozen snapshot.",
        "CommandLine.resource producing the same resource for two commands that execute differently (shell: true vs argv, custom shell), a chained shell line that a prefix grant still matches, or a pipeline checked as one joined resource instead of once per CommandLine.stages entry.",
        "A spawner method (string, lines, exitCode, stream*) or pipeline leg that reaches the host spawner without passing the guarded spawn.",
        "An env override the child would not inherit (a name outside ChildProcessEnvironment.isInheritedName such as LD_PRELOAD, GIT_*, NODE_OPTIONS, or a PATH/HOME value that differs from the ambient one) missing from the CommandLine.resource env prefix, or a cwd outside Workspace.root missing its cwd prefix, so it changes what a granted line executes while staying outside the grant.",
        "A ProcessConfinement.profile that opens a tree no fs:* allow in force covers (a deny or ceiling ignored, a grant outside the workspace anchored inside it), or a spawn that reaches the host spawner before confine() ran when a ProcessConfinement is in context."
      ],
      paths: [
        "src/ChildProcessSpawner.ts",
        "src/CommandLine.ts",
        "src/Rooted.ts",
        "src/ProcessConfinement.ts",
        "src/GrantStore.ts",
        "src/internal/Pipeline.ts"
      ]
    },
    {
      id: "child-env-least-authority",
      title: "Children inherit no host credentials unless the caller declares them",
      threat: "A spawned tool or agent reads the host's API keys, tokens, or cookies from its environment.",
      lookFor: [
        "A credential-shaped ambient name (e.g. GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY) that credentialNamePattern fails to match.",
        "A path that passes extendEnv or merges process.env instead of the null-prototype record from ChildProcessEnvironment.make.",
        "Case-variant or duplicate names letting an ambient value survive a declared undefined removal."
      ],
      paths: ["src/ChildProcessEnvironment.ts", "src/ChildProcessSpawner.ts", "src/ContainedSpawner.ts"]
    },
    {
      id: "fs-confinement",
      title: "Confined filesystem access never escapes the workspace root",
      threat:
        "A flow granted workspace file access reads or writes host files outside the workspace via symlinks, hard links, or '..'.",
      lookFor: [
        "canonicalResource or isInside accepting a path whose realpath leaves the root (prefix match without separator, symlink loop past depth 40, missing ancestor).",
        "A check-then-use window where the path is authorized by name and then opened by name, letting a symlink be swapped in between.",
        "An operation in confined() (glob root, temp directory, rename/copy destination, open flags) that is not refused or not routed through the atomic host.",
        "Rooted.fileSystem mistaken for confinement: absolute paths and symlink targets pass through it unchanged."
      ],
      paths: ["src/FileSystem.ts", "src/FileSystemBatch.ts", "src/Rooted.ts", "src/Path.ts", "src/Workspace.ts"]
    },
    {
      id: "http-grant-per-hop",
      title: "Every HTTP hop is authorized for its own scheme, host, and model",
      threat:
        "A flow granted one origin or model reaches another host, cleartext transport, or a different model through redirects or URL tricks.",
      lookFor: [
        "A redirect followed by the underlying client (redirect not forced to manual) or a hop that skips the guarded postprocess.",
        "capabilityFor collapsing distinct targets to one resource (userinfo, port, IDN or case, non-https scheme mapped to a bare host).",
        "A request mutated after the check (body, url, urlParams) because the snapshot does not deep-copy it.",
        "ModelCall intent that lets a model:call grant for one model id authorize another."
      ],
      paths: ["src/HttpClient.ts"]
    },
    {
      id: "grant-store-authority",
      title: "Grants never widen past the ambient ceiling or the approved pattern",
      threat: "A flow or a forged reply escalates its own capabilities or reuses another run's approval.",
      lookFor: [
        "reply accepting a supplied pattern broader than the pending capability or outside the entry's captured ceiling.",
        "A run or remembered rule evaluated without intersecting the CapabilitySet current at request time.",
        "An envelope grant whose planDigest or scope is not bound to the run that replays it.",
        "Request ids that are guessable across runs, or a double reply that activates two rules."
      ],
      paths: ["src/GrantStore.ts", "src/CapabilitySet.ts", "src/GrantEvent.ts", "src/internal/makeCapability.ts"]
    },
    {
      id: "grant-journal-replay",
      title: "Replayed grant journals cannot inject or reshape authority",
      threat:
        "Anyone able to append to the run journal forges remembered or envelope grants that activate on the next start.",
      lookFor: [
        "decodeTrustedEntry trusting an entry by sourceId and eventType alone without binding it to the policy run and plan digest.",
        "Payload schema allowing excess properties, oversized patterns, or rule counts past maximumRules on replay.",
        "A replayed run grant activated without its captured ceiling."
      ],
      paths: ["src/JournalGrantStore.ts", "src/GrantEvent.ts"]
    },
    {
      id: "process-ledger-reaping",
      title: "The process ledger never leads a reaper to signal an unrelated process",
      threat: "A stale or forged ledger record makes a later host kill another user's or the host's own process group.",
      lookFor: [
        "A record whose pgid is the host's own group (non-detached child) or a Windows record carrying a pgid.",
        "Records keyed by pid alone so pid reuse retires or signals the wrong process.",
        "commandDigest storing arguments (credentials) instead of CommandLine.executable."
      ],
      paths: ["src/ProcessLedger.ts", "src/ContainedSpawner.ts", "src/internal/Containment.ts", "src/CommandLine.ts"]
    },
    {
      id: "jj-capability-resource",
      title: "jj operations are checked against a canonical workspace resource",
      threat:
        "A flow granted jj access to its workspace mutates another repository or writes through an unchecked jj path.",
      lookFor: [
        "A Jj method that reaches @smthrs/jj without a GrantStore check, or a write operation checked as a read.",
        "A repository path passed to makeCapability without canonicalResource."
      ],
      paths: ["src/Jj.ts"]
    },
    {
      id: "allow-all-layers-not-production",
      title: "Allow-all grant stores and noop host layers never reach production wiring",
      threat: "A host that wires GrantStore.layerNoop or a test helper allows every capability to every flow.",
      lookFor: [
        "GrantStore.layerNoop (allow-all, exported from the main entry) or test/TestGrantStore layerAllow selected by a non-test code path.",
        "A noop layer (ChildProcessSpawner, HttpClient, Workspace, Jj layerNoop) that skips GrantStore.check while providing the guarded tag.",
        "An allow-all default in a helper that production HostServices.layer could select."
      ],
      paths: [
        "src/test/**",
        "src/GrantStore.ts",
        "src/HostServices.ts",
        "src/index.ts",
        "src/ChildProcessSpawner.ts",
        "src/HttpClient.ts",
        "src/Workspace.ts",
        "src/Jj.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
