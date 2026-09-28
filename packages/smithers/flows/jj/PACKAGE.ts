import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/jj",
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
})

/**
 * The package's fault-injection cases.
 *
 * A package opts into the matrix by declaring this key, so
 * `//packages/...:faults` is the whole matrix and nothing central lists which
 * packages are in it. The tier is separate from `test` because its cases are
 * machine-global — they kill process groups, bind ephemeral ports, and read
 * the process table — so they run serially, without coverage, from
 * `vitest.faults.config.ts`.
 */
const faults = Smithers.FaultSuite({ cwd: "packages/smithers/flows/jj" })

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/jj",
  include: ["src/**"],
  checks: [
    {
      id: "jj-argv-option-injection",
      title: "Caller-supplied names, paths, revisions, and operation ids never parse as jj options",
      threat:
        "An agent or journal row that controls a lane name, lane path, or revision makes the host jj read a --config/--config-file or --repository it chose, running with attacker config against the operator's repositories.",
      lookFor: [
        "An argv array in operations() where a caller value is a bare positional without a preceding \"--\" or a --flag=value form (workspaceAdd, workspaceForget, opRestore).",
        "inRepository inserting --color/--config after the \"--\" delimiter, so a global option lands among positionals or a positional lands among options.",
        "A revision passed to restore/diff/revert as a separate argv item after --from/-r that jj could accept when it begins with \"-\".",
        "opRestore reaching jj with an operationId that is not matched by the /^[0-9a-f]+$/ guard."
      ],
      paths: ["src/node/NodeJj.ts"]
    },
    {
      id: "jj-revset-injection",
      title: "A revision value names one commit and cannot widen into an arbitrary revset",
      threat:
        "A caller that controls a journaled revision string restores, diffs, or pins a lane to commits other than the recorded snapshot, overwriting the user's working copy with another change's tree.",
      lookFor: [
        "String interpolation of a revision into a revset expression such as `--revision=parents(${pinned})` without validating it as a hex commit id or reverse-hex change id.",
        "requireRevision accepting anything beyond non-empty, so `x) | all() | (x` or `root()` reaches jj restore --from."
      ],
      paths: ["src/node/NodeJj.ts", "src/browser/BrowserJj.ts"]
    },
    {
      id: "jj-binary-resolution",
      title: "The spawned jj is the binary the operator chose, at an absolute path",
      threat:
        "Someone who can write a directory on PATH or the process cwd makes Smithers execute their own jj with the user's privileges and credentials.",
      lookFor: [
        "resolveJjBinary returning a relative path, or a PATH entry that is empty or \".\" resolving against the working directory instead of being skipped.",
        "NodeJj spawning binary.path when it is not absolute, or spawning the bare name \"jj\" through PATH lookup.",
        "The version-probe cache keyed so a probe under one spawner or path authorizes a different binary.",
        "permissionHint or describe emitting an override path into shell remediation text without shellQuote."
      ],
      paths: ["src/node/resolveJjBinary.ts", "src/node/NodeJj.ts"]
    },
    {
      id: "jj-config-program-exec",
      title: "Repository or workspace jj config cannot make the host jj run a program the operator did not choose",
      threat:
        "An agent that can write a lane's .jj directory or the repo config sets signing, fsmonitor, or tool keys so the next host-side jj snapshot, revert, or workspace add executes its program with the operator's privileges and inherited environment.",
      lookFor: [
        "inRepository and the pinned-restore run in workspaceAdd pinning only color and snapshot.max-new-file-size, leaving signing.behavior, signing.backends.*.program, fsmonitor.backend, and ui.diff-formatter to repo or JJ_CONFIG values.",
        "A jj child spawned with the full process.env (secrets, JJ_CONFIG) instead of a minimal environment.",
        "A workspace cwd from a caller path whose .jj config the host jj loads before any argv override applies."
      ],
      paths: ["src/node/NodeJj.ts"]
    },
    {
      id: "wasi-preopen-escape",
      title: "The WASI guest cannot read, write, or link outside the preopened root",
      threat:
        "A malicious or buggy wasm guest reads or overwrites host files outside the mounted repository root in the browser mount or the Node test backend.",
      lookFor: [
        "A path_* syscall that hands fs a host path not produced by resolvePath/walk, or skips notRoot on a mutation.",
        "walk or resolveLinkTarget letting \"..\" or an absolute symlink target climb past the namespace root, or not re-rooting each symlink hop.",
        "path_symlink writing a guest-controlled absolute target that the backend later follows outside the root when the shim itself does not walk it.",
        "fd-addressed operations resolved through a path captured at open time, so a rename plus symlink redirects a later mutation."
      ],
      paths: ["src/browser/WasiPreview1.ts", "src/browser/WasiFs.ts"]
    },
    {
      id: "wasi-memory-bounds",
      title: "Guest pointers and lengths never read or write outside wasm linear memory or exhaust the host",
      threat:
        "A wasm guest passes crafted iovec pointers or lengths that crash the page, corrupt shim state, or force unbounded host allocation.",
      lookFor: [
        "A DataView or Uint8Array over memory.buffer built from guest ptr/len without the bounds-checking constructor path, or with ptr+len overflow before >>> 0.",
        "A RangeError path not mapped to Errno.fault, letting an exception unwind through the wasm stack.",
        "fd_read/fd_readdir/path_readlink sizing a host buffer from a guest-supplied length without a cap."
      ],
      paths: ["src/browser/WasiPreview1.ts"]
    },
    {
      id: "jj-abi-response-trust",
      title: "Output from the jj child or the wasm ABI is parsed as untrusted data",
      threat:
        "A hostile repository or guest crafts jj output that makes the host journal a wrong commit id, misclassify a failure as success, or exhaust memory.",
      lookFor: [
        "decodeResponse or the initialize response accepting fields without type checks before use as commit ids or paths.",
        "A child stdout/stderr buffer that grows past outputLimit before the check fires.",
        "settle treating exit code 0 as success while stderr reports refused snapshot files.",
        "snapshot using an empty commitId from a malformed jj log line as a restore target."
      ],
      paths: ["src/node/NodeJj.ts", "src/browser/BrowserJj.ts"]
    },
    {
      id: "jj-error-leakage",
      title: "Journaled JjError fields stay bounded and carry no secrets",
      threat:
        "A failing jj invocation writes environment secrets, full file contents, or long user paths into the durable journal that other tenants or UIs read.",
      lookFor: [
        "A JjError constructed with an unbounded message or command instead of commandOf/jjErrorCause truncation.",
        "A cause projection that copies an Error's stack, env, or spawnargs into the journal."
      ],
      paths: ["src/Jj.ts", "src/node/NodeJj.ts", "src/browser/BrowserJj.ts"]
    },
    {
      id: "jj-lock-and-restore-safety",
      title: "Repository locks and destructive restores cannot be stolen or aimed at another workspace",
      threat:
        "A concurrent process or crafted lock entry makes two jj operations mutate one workspace at once, or opRestore discards another agent's workspace changes.",
      lookFor: [
        "reclaimDeadLock removing an owner entry whose hostname differs or whose pid is alive, or following a symlink planted at .jj/<lock>.",
        "workspaceAdd's pinned restore running in a directory resolved from a caller path outside the bound repository root.",
        "opRestore running jj op restore without the workspace-list equality check, or with --what broader than repo."
      ],
      paths: ["src/node/NodeJj.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, faults, fmt, lib, lint, test, ...securityReview }
})
