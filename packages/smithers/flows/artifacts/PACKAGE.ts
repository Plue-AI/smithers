import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/artifacts"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/artifacts" })

/**
 * Security review of the artifact store: content addressing, the filesystem
 * tier's path and lock handling, and the remote HTTP tier's credentials.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/artifacts",
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "digest-verified-before-use",
      title: "Every read path refuses bytes whose SHA-256 does not match the requested digest",
      threat: "A compromised shared cache or a writer to the workspace objects directory substitutes content that replays and steps then trust as recorded output.",
      lookFor: [
        "A get in FileSystemArtifactStore, RemoteArtifacts, or CombinedArtifacts that returns bytes without comparing measureBytes to the validated digest.",
        "CombinedArtifacts writing remote bytes into the local tier before the remote tier verified them.",
        "A put dedupe hit that trusts an existing blob without re-hashing it."
      ],
      paths: ["src/FileSystemArtifactStore.ts", "src/RemoteArtifacts.ts", "src/CombinedArtifacts.ts", "src/measureBytes.ts"]
    },
    {
      id: "digest-path-injection",
      title: "A digest is validated as 64 lowercase hex before it reaches a path, URL, lock name, or log",
      threat: "A caller that controls a digest read back from a durable row reads, deletes, or requests a file or URL outside the objects directory or /cas/ prefix.",
      lookFor: [
        "A fanout, blobPath, casUrl, or lock path built from a digest that did not pass validateDigest first.",
        "A relaxed validateDigest regex that admits '/', '.', '%', or uppercase.",
        "findMissing or remove accepting a digest list without validating each entry."
      ],
      paths: ["src/validateDigest.ts", "src/FileSystemArtifactStore.ts", "src/ArtifactSweep.ts", "src/RemoteArtifacts.ts", "src/internal/ArtifactLocks.ts"]
    },
    {
      id: "objects-dir-symlink-race",
      title: "Writes, renames, and deletes under the objects directory never follow a planted symlink",
      threat: "Another local user or a sandboxed step with write access to the workspace redirects a publish or sweep delete to a file outside the objects directory.",
      lookFor: [
        "A fs.rename, fs.remove, fs.open, or makeDirectory under the objects directory not preceded by ArtifactPath.guard on the root, fanout parent, and entry.",
        "The .locks directory created or written without a symlink guard.",
        "ArtifactPath.guard treating a readlink failure other than NotFound or EINVAL as 'not a link'."
      ],
      paths: ["src/FileSystemArtifactStore.ts", "src/ArtifactSweep.ts", "src/internal/ArtifactPath.ts", "src/internal/ArtifactLocks.ts"]
    },
    {
      id: "sweep-deletes-only-canonical-blobs",
      title: "Sweep and orphan cleanup delete only canonical fanout blobs or stale scratch files",
      threat: "A foreign file in the objects directory, or a blob a concurrent put or backup still needs, is deleted and the workspace loses data.",
      lookFor: [
        "inventory admitting an entry whose name is not 64 hex under its own two-hex fanout.",
        "sweepOrphanedTemps removing an entry younger than staleScratchMs or whose mtime is unknown.",
        "remove deleting without the ifUnmodifiedSinceMs fence or without ArtifactBackupLease.unlessActive under required coordination."
      ],
      paths: ["src/ArtifactSweep.ts", "src/FileSystemArtifactStore.ts", "src/ArtifactBackupLease.ts"]
    },
    {
      id: "lease-ownership",
      title: "A file lease is released, freshened, or reclaimed only by its owner or after it is stale",
      threat: "A concurrent process displaces a live holder's lock and two writers or a writer and a sweeper mutate one digest at once.",
      lookFor: [
        "release or heartbeat touching lockPath without comparing the file content to this owner token.",
        "reclaim renaming a lock without winning the wx claim file and re-reading the same stale generation.",
        "A lock or claim path derived from unsanitized owner text."
      ],
      paths: ["src/FileLease.ts", "src/internal/ArtifactLocks.ts", "src/ArtifactBackupLease.ts"]
    },
    {
      id: "remote-endpoint-credentials",
      title: "Remote tier credentials never leave over plaintext or reach logs, errors, or spans",
      threat: "A network attacker or log reader obtains the bearer token the deployment configured for the shared cache.",
      lookFor: [
        "An endpoint accepted with http: for a host that is not loopback, or with userinfo, query, or fragment.",
        "An ArtifactStoreError message or log annotation that interpolates the endpoint, a header, or the raw transport cause.",
        "Configured header names missing from Headers.CurrentRedactedNames on a request.",
        "A header value with CR or LF accepted at construction.",
        "A request sent through the ambient HttpClient without refusing 3xx, so a cache redirect to another origin or to http: replays the configured credential headers there."
      ],
      paths: ["src/RemoteArtifacts.ts", "src/CombinedArtifacts.ts"]
    },
    {
      id: "remote-response-bounds",
      title: "Responses from the shared tier are bounded in size and time and cannot widen the caller's work",
      threat: "A hostile or broken cache server exhausts this process's memory, stalls a run forever, or makes it upload digests it never asked about.",
      lookFor: [
        "A download or findMissing body read without readBounded or past maxDownloadBytes.",
        "A request not wrapped by within() with a finite deadline.",
        "findMissing returning a digest that was not in the requested batch.",
        "A 308 Range answer that can move the chunked upload offset backwards or loop forever."
      ],
      paths: ["src/RemoteArtifacts.ts"]
    },
    {
      id: "docs-credential-hygiene",
      title: "Docs examples keep credentials out of source and endpoints on HTTPS",
      threat: "A user copying a guide snippet hardcodes a cache token or configures a plaintext endpoint.",
      lookFor: [
        "A literal token, key, or password in a docs or README code block.",
        "An example endpoint using http: for a non-loopback host.",
        "A documented refusal rule that disagrees with RemoteArtifacts.make."
      ],
      paths: ["docs/**", "README.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
