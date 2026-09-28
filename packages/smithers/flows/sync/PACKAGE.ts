import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/flows/sync"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  checks: [
    {
      id: "capability-signature",
      title: "Share and workspace capabilities verify only under their own key, scheme, and claim encoding",
      threat:
        "A share-link holder forges or widens a capability to read or write another branch or the whole workspace.",
      lookFor: [
        "A signed claim field omitted from `canonical`, or a field encoded without the UTF-8 byte-length prefix.",
        "A scheme label shared between BranchShare and WorkspaceShare, or missing from either canonical encoding.",
        "A signature comparison that is not `constantTimeEquals`, or a lone-surrogate claim that signs instead of being refused.",
        "A verify path that reads `capability.claims` after the Web Crypto await instead of the `snapshot` copy.",
        "A `kid` lookup that falls back to the active key when the named kid is unknown.",
        "`importHmacKey` or `layerConfig` accepting a short or low-entropy secret with no minimum byte length."
      ],
      paths: ["src/internal/ShareSigner.ts", "src/BranchShare.ts", "src/WorkspaceShare.ts"]
    },
    {
      id: "check-order-and-expiry",
      title: "Signature is checked before scope, expiry, and access, and expiry is exclusive",
      threat:
        "A holder of an expired or read-only capability keeps reading or writes to a branch they were only shown.",
      lookFor: [
        "`verifyClaims` reporting scope or expiry before the signature check.",
        "An expiry comparison using `>` instead of `>=` against the clock.",
        "A `read` capability accepted where `access: \"write\"` is requested."
      ],
      paths: ["src/internal/ShareSigner.ts"]
    },
    {
      id: "auth-header-fail-closed",
      title: "A present but invalid workspace header is refused, never downgraded to anonymous",
      threat: "A network client sends a garbage or expired `flows-sync-workspace` header and reads workspace runs.",
      lookFor: [
        "A branch in `SyncAuth.layer` that provides a Workspace principal without `share.verify` succeeding.",
        "A decode failure that returns a distinct message usable as a parsing oracle, or echoes the credential in `cause`.",
        "Any transport-reachable use of `SyncPrincipal.layerWorkspace` or a default principal other than anonymous."
      ],
      paths: ["src/SyncAuth.ts", "src/SyncPrincipal.ts", "src/SyncRpcs.ts"]
    },
    {
      id: "run-read-authz",
      title: "Non-branch runs need the workspace principal and branch runs need a verified capability for that branch",
      threat:
        "An anonymous caller or a holder of one branch's link reads another branch's or the workspace's journal entries.",
      lookFor: [
        "A Snapshot, Read, or Subscribe path that reaches the journal before `runIdsFor` authorizes the scope.",
        "`branchOfRunId` mapping a run id to a branch other than the one whose journal it reads.",
        "`branchClaims` folding a non-`unauthorized` error, or a verify for `write`, into a successful read grant.",
        "A catalog-discovered run added to a workspace subscription without passing `followUntil`."
      ],
      paths: ["src/SyncServer.ts", "src/BranchProtocol.ts", "src/RunCatalog.ts", "src/internal/SnapshotBoundary.ts"]
    },
    {
      id: "subscription-revocation",
      title: "An open subscription ends when the soonest credential behind it expires",
      threat: "A holder of an expired capability keeps streaming a branch or workspace by never disconnecting.",
      lookFor: [
        "A stream opened without `untilExpiry`, or with an expiry that is not the minimum over every admitting capability.",
        "A branch run admitted by reconciliation whose capability expiry does not tighten the stream deadline.",
        "Snapshot or Read responses returned after the credential expiry checked before the journal read."
      ],
      paths: ["src/SyncServer.ts"]
    },
    {
      id: "branch-mint-delegation",
      title: "Branch creation needs the workspace principal and delegated links never outlive or out-scope the parent",
      threat:
        "An anonymous caller creates branches, or a read-link holder mints a write link or one that outlives its parent.",
      lookFor: [
        "`Branch.CreateBranch` minting without checking `SyncPrincipal.isWorkspace`.",
        "`Branch.MintShare` verifying the parent with `read` access, or minting for a branch other than the verified `claims.branchId`.",
        "A minted child `expiresAtMs` not capped by `maxExpiresAtMs`, or a `ttlMs` above `maximumBranchTtlMs` accepted.",
        "An id source other than `crypto.randomUUID` in a non-test layer, making branch ids guessable."
      ],
      paths: ["src/BranchServer.ts", "src/BranchRpcs.ts", "src/BranchShare.ts", "src/BranchIds.ts"]
    },
    {
      id: "branch-write-integrity",
      title: "Commands and presence writes are authorized for the exact branch they mutate",
      threat:
        "A write-link holder on one branch appends commands or evicts participants on another branch, or impersonates a peer.",
      lookFor: [
        "A submit or announce whose `branchId` is read from the caller's object after `share.verify` instead of the frozen copy.",
        "`Branch.Leave` or `announce` letting one capability remove or overwrite a `participantId` it did not announce.",
        "A command admitted before `share.verify`, or a permit taken before authorization."
      ],
      paths: ["src/BranchCommands.ts", "src/BranchPresence.ts", "src/BranchServer.ts"]
    },
    {
      id: "resource-bounds",
      title: "Frame, command, roster, ledger, and credit limits bound every unauthenticated or share-link caller",
      threat: "A share-link holder or anonymous client exhausts server memory or CPU for every workspace reader.",
      lookFor: [
        "A request `limit`, `credit`, or cursor list admitted without `maxReadLimit`, `maxSubscribeCredit`, or a length bound.",
        "A command size measured after the journal append, or a roster without `maxParticipants`.",
        "Per-branch state (`RcMap`, receipts ledger, presence map) that grows without idle eviction or a capacity.",
        "A policy option accepting NaN, Infinity, or a negative number as a limit."
      ],
      paths: [
        "src/SyncServer.ts",
        "src/BranchCommands.ts",
        "src/BranchPresence.ts",
        "src/SyncProtocol.ts",
        "src/internal/PolicyOptions.ts"
      ]
    },
    {
      id: "fail-closed-fallback-layers",
      title: "Noop and test layers refuse every capability and never grant the workspace principal to a transport",
      threat:
        "A remote client of a gateway wired with a published noop or test layer reads every workspace run without a credential.",
      lookFor: [
        "A `makeNoop` authority whose `verify` succeeds, or a `SyncServer.layerNoop` that returns journal data.",
        "The published `./test/TestSync` export `layerTrustAllAsOwner` (trusts every connection as owner) reachable from a non-test composition."
      ],
      paths: ["src/test/**", "src/WorkspaceShare.ts", "src/BranchShare.ts", "src/SyncServer.ts", "src/SyncAuth.ts"]
    },
    {
      id: "error-leakage",
      title: "Errors on the wire carry bounded text and never a credential or host object",
      threat: "A remote client learns signing secrets, capabilities, or host internals from a SyncError cause.",
      lookFor: [
        "A `SyncError` built with a raw `cause` object, schema issue, or capability value instead of `causeText`.",
        "A `Redacted` secret unwrapped anywhere except the key import.",
        "A client-side decode that trusts a server frame without `Admission.decode`."
      ],
      paths: [
        "src/SyncError.ts",
        "src/internal/CauseText.ts",
        "src/SyncClient.ts",
        "src/WorkspaceShare.ts",
        "src/BranchShare.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
