import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/flows/platform-node"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "atomic-helper-provenance",
      title: "The atomic filesystem helper executed is never one the confined workspace supplied",
      threat: "A flow running in a confined workspace plants or rewrites smithers-jj-export and gets its code run by the host outside the sandbox.",
      lookFor: [
        "A resolution path in resolveDefaultExecutable, resolveConfiguredExecutable or usableExecutable that returns a file inside boundaryRoot without staging it outside the workspace.",
        "A symlink, hard link or `..` component in the configured path that makes the inside(boundaryRoot, resolved) check describe a different file from the one spawned (TOCTOU between realpath and spawn).",
        "stagePackaged/outsideWorkspace copying into a staging directory that is not 0700 and freshly mkdtemp'd, or a cached staged path reused after it was replaced.",
        "Any fallback that consults PATH, the process cwd, or a workspace-relative node_modules install to find the helper.",
        "A helper inside boundaryRoot (checkout target/release or target/debug, or an embedded path) copied out by outsideWorkspace at the first request instead of at layer build, so bytes a flow wrote before that request still run.",
        "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY or options.executable re-read on every request, so a later change to the variable redirects which binary runs."
      ],
      paths: ["src/AtomicFileSystem.ts", "src/internal/AtomicFileSystemExecutable.ts", "src/internal/AtomicFileSystemTransport.ts"]
    },
    {
      id: "atomic-protocol-bounds",
      title: "Helper requests and responses stay inside the declared byte, count and time ceilings",
      threat: "A malicious or broken helper, or a flow issuing huge reads or batches, exhausts host memory or stalls the host indefinitely.",
      lookFor: [
        "A stdout, stderr or batch-entry buffer that is accumulated before its limit is checked, or a frame length read from the helper trusted before comparison with limits.response.",
        "decode/convert in AtomicFileSystemProtocol accepting a declared length, base64 payload or directory listing larger than limits.content or limits.response.",
        "A code path that spawns a helper outside the layer semaphore or without the timeoutMs deadline and SIGKILL cleanup.",
        "A limit override accepted above hardLimitBytes or a batchSize above KernelFileSystem.maxBatchSize."
      ],
      paths: ["src/AtomicFileSystem.ts", "src/internal/AtomicFileSystemProtocol.ts", "src/internal/AtomicFileSystemTransport.ts"]
    },
    {
      id: "atomic-no-follow-authorization",
      title: "noFollowAuthorization is only claimed where the helper actually enforces descriptor-relative O_NOFOLLOW walks",
      threat: "A flow uses a symlink inside its workspace to read or write host files outside the boundary root.",
      lookFor: [
        "An operation routed to the stock NodeFileSystem (realPath, watch, identifyRoot or any spread field) that follows symlinks while the layer advertises noFollowAuthorization: true.",
        "A request field (path, boundaryRoot) forwarded to the helper without the boundary root the kernel pinned, or a result path converted back without checking it stays under that root."
      ],
      paths: ["src/AtomicFileSystem.ts", "src/internal/AtomicFileSystemProtocol.ts"]
    },
    {
      id: "helper-env-isolation",
      title: "Every native helper and supervisor child starts with an explicit minimal environment and inert cwd",
      threat: "Host secrets in process.env (model keys, tokens) leak into helper or supervisor processes, or an attacker-controlled cwd or env variable (NODE_OPTIONS, BUN config, PATH) injects code into them.",
      lookFor: [
        "A spawn or spawnSync of the atomic helper, ps, the supervisor program or the Windows job helper that omits env or passes process.env.",
        "A PATH-relative executable name (for example spawnSync(\"taskkill\") or ps without an absolute path) that a writable directory or Windows cwd search could hijack.",
        "SMITHERS_PROCESS_CHANNEL or SMITHERS_PROCESS_JOB_HELPER not deleted from the supervisor's env before the target command is spawned."
      ],
      paths: ["src/ProcessReaper.ts", "src/internal/ProcessSupervisor.ts", "src/internal/SupervisorProgram.ts", "src/internal/WindowsProcessJob.ts", "src/internal/AtomicFileSystemTransport.ts"]
    },
    {
      id: "supervisor-channel-auth",
      title: "Only the host that started a supervisor can connect to and command it",
      threat: "Another local user or a sandboxed process connects to the supervisor control socket and issues spawn, stop or cleanup commands, or impersonates the owner to the host.",
      lookFor: [
        "A Unix socket directory created without mkdtemp plus chmod 0700 before listen, or a predictable /tmp path.",
        "The TLS PSK loopback server accepting a connection before the PSK identity and 32-byte random key match, or a key logged or passed on argv instead of env.",
        "Supervisor JSON messages parsed and acted on (pids, signals, commands) without validating type and shape."
      ],
      paths: ["src/internal/ProcessSupervisor.ts", "src/internal/SupervisorProgram.ts"]
    },
    {
      id: "reaper-signal-targeting",
      title: "The reaper and supervisor signal only process groups whose identity they re-verified",
      threat: "A forged or stale ledger record, or pid reuse, makes the host SIGKILL an unrelated process, its own group, or pid 1 of the user's session.",
      lookFor: [
        "process.kill with a negative pid whose pgid is not checked to be a safe integer above 1, equal to pid, and different from the host's own group.",
        "A kill issued when start time is unavailable or boot time predates the record, contrary to the module contract.",
        "ps or /proc output parsed with a regex that lets a crafted command name shift columns into pid, pgid or start time.",
        "taskkill /T issued for a Windows record naming the owner pid or an ancestor."
      ],
      paths: ["src/ProcessReaper.ts", "src/HostLiveness.ts", "src/internal/ProcSnapshot.ts", "src/internal/ProcessCleanup.ts", "src/internal/SupervisorProgram.ts"]
    },
    {
      id: "egress-proxy-bypass",
      title: "Outbound HTTP honours the environment's egress proxy for every non-loopback origin",
      threat: "Code inside a default-deny sandbox reaches arbitrary origins directly, bypassing the egress proxy's allowlist and audit.",
      lookFor: [
        "A loopback exemption wider than exactly localhost, 127.0.0.1 and ::1 (for example a suffix or CIDR match that also exempts attacker-registered hostnames).",
        "A NodeHost layer composing NodeHttpClient.layerUndici or makeDispatcher directly instead of EgressHttpClient.layer.",
        "A redirect interceptor installed on the dispatcher so hops escape the kernel's redirect decorator."
      ],
      paths: ["src/EgressHttpClient.ts", "src/NodeHost.ts"]
    },
    {
      id: "contained-host-bypass",
      title: "Contained host layers route every child process, including jj, through the reaping spawner",
      threat: "A flow in a contained host starts processes that escape the ledger and survive the run, keeping access to the workspace and credentials.",
      lookFor: [
        "layerContained or layerContainedAt providing NodeJj.layer or the raw NodeChildProcessSpawner instead of the ProcessReaper spawner.",
        "PipedProcess.spawn or ScopedProcess started with detached/shell options that leave no recorded process group."
      ],
      paths: ["src/NodeHost.ts", "src/ScopedProcess.ts", "src/internal/PipedProcess.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
