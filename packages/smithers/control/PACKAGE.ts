import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/control"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/control",
  checks: [
    {
      id: "rpc-principal-stamping",
      title: "Every remote mutation is attributed to the authenticated principal, never a client-supplied one",
      threat:
        "A bearer holder or in-process caller spoofs the local operator identity so the journal, cancellation, and approval policy trust a principal they are not.",
      lookFor: [
        "A ControlServer handler (Run, Approve, Deny, Steer, Signal, Cancel, Resume) that forwards input.principal instead of overwriting it with ControlPrincipal.",
        "stampPrincipal defaulting an absent principal to local/operator on a path reachable from a remote or channel caller (Channels ingest passes none).",
        "A ControlRpcs procedure outside the ControlAuth middleware, or a production composition wiring layerNoopAuth to a listening server.",
        "The fingerprint or mutationKey dropping principal id/kind so one principal replays another principal's receipt."
      ],
      paths: [
        "src/ControlServer.ts",
        "src/ControlRpcs.ts",
        "src/ControlLive.ts",
        "src/SqlControlRuntime.ts",
        "src/ControlRuntime.ts",
        "src/Channels.ts"
      ]
    },
    {
      id: "approval-authority",
      title: "Approval and denial decisions pass the host ApprovalAuthority before any grant, replay, or resume",
      threat:
        "An authenticated non-operator, agent, or gateway identity approves a plan or node gate and runs work the owner never authorized.",
      lookFor: [
        "An approve/deny path that reads the target, replays a stored receipt, or installs a grant before authorizeApproval runs.",
        "resolveApproval or installBulkGrant called without the authority recheck inside the same write transaction.",
        "ApprovalAuthority.compile granting a scope or target the delegation did not list (cross product of targets and scopes, or hierarchical scope inference).",
        "answerableWait treating a caller-chosen Node digest as a HumanTask wait token so an approval for one wait answers another run's wait."
      ],
      paths: [
        "src/ApprovalAuthority.ts",
        "src/ControlLive.ts",
        "src/ControlRuntime.ts",
        "src/SqlControlRuntime.ts",
        "src/ControlExecutor.ts"
      ]
    },
    {
      id: "run-requires-approved-plan",
      title: "A run starts only from an approved plan whose digest and envelope match what was approved",
      threat:
        "A bearer holder launches a deploy-class system flow (release, serve, up, gc) or edited flow code that no operator approved.",
      lookFor: [
        "launch starting a run when the stored plan decision is pending or denied, or before comparing the requested digest and envelope with the stored card.",
        "planCard computing the digest without flowId, decoded input, envelope, executionDigest, or deployClass, so an approval covers a different flow or input.",
        "A reserved system flow with plannable false reaching plan or run, or a system/* id accepted from a client without the SystemFlows catalog lookup.",
        "Resume or steer waking a run outside launched scope, so a client restarts an engine-owned run the plane never admitted."
      ],
      paths: ["src/ControlLive.ts", "src/SqlControlRuntime.ts", "src/ControlRuntime.ts", "src/SystemFlows.ts"]
    },
    {
      id: "signal-approval-bypass",
      title: "A signal cannot complete a human approval wait that requires ApprovalAuthority",
      threat:
        "A bearer holder or a webhook channel mapping to Signal answers a HumanTask or WaitFor approval gate by name and skips the operator-only approval policy.",
      lookFor: [
        "Control.signal or executor.deliverSignal completing a wait whose reason is humanWaitReason (\"approval\") without calling authorizeApproval.",
        "Channels ingest producing a Signal for a run id and wait name taken straight from an unauthenticated payload without scoping to runs that channel started.",
        "Signal admission binding a wait token another command already reserved, or rebinding a delivered/terminal command."
      ],
      paths: [
        "src/ControlLive.ts",
        "src/ControlExecutor.ts",
        "src/SqlControlRuntime.ts",
        "src/Channels.ts",
        "src/migrations/0003_signal_commands.ts"
      ]
    },
    {
      id: "webhook-ingress",
      title: "Webhook bytes are size-bounded and signature-verified before any decode, lookup, or Control call",
      threat:
        "An unauthenticated internet caller exhausts server memory, starts flows, or replays another channel's idempotent receipt through a webhook mount.",
      lookFor: [
        "WebhookChannel.handler buffering the body before comparing declared or streamed length with maximumBodyBytes.",
        "Channels.ingest calling decodeAndMap, lookupMutation, or control.* before channel.verify, or passing the verifier a body the decoder later sees mutated.",
        "fingerprintHeaders accepting authorization, signature, or cookie headers so a secret reaches the durable idempotency fingerprint.",
        "scopedKey/mutationKey letting two channel names or external keys collide (missing length prefix or separator ambiguity)."
      ],
      paths: ["src/WebhookChannel.ts", "src/Channels.ts"]
    },
    {
      id: "credential-confidentiality",
      title:
        "Credential plaintext exists only inside Redacted and AES-GCM ciphertext is bound to its id, name, and version",
      threat:
        "Anyone reading the control database, logs, or journal learns a stored connection secret, or swaps one credential's ciphertext onto another reference.",
      lookFor: [
        "Redacted.value called anywhere but WebCryptoCipher seal/open, or a plaintext, key, or ciphertext placed in an error message or log field.",
        "A nonce reused across versions, not taken from crypto.getRandomValues, or not 12 bytes; additionalData omitting id, name, or version.",
        "Credential.resolve/rotate/revoke using a caller CredentialRef without re-reading the stored record and matching its name after authorize.",
        "Credential.get or list returning a reference before the host authorize hook runs, or distinguishing missing from denied ids in its error.",
        "SqlCredentialStore.write committing without the version compare-and-set in the same DurableWriter transaction."
      ],
      paths: [
        "src/Credential.ts",
        "src/CredentialCipher.ts",
        "src/WebCryptoCipher.ts",
        "src/CredentialStore.ts",
        "src/SqlCredentialStore.ts"
      ]
    },
    {
      id: "bearer-token-auth",
      title: "The control RPC bearer check fails closed and leaks nothing about the token",
      threat:
        "A network attacker reaching /rpc or /rpc/ws guesses, times, or bypasses the shared bearer token and drives every run on the host.",
      lookFor: [
        "bearerAuthenticator accepting an empty configured token, a missing header, or comparing with an early-exit equality.",
        "The /rpc/ws watch stream served without ControlAuth, or without an Origin check when a proxy injects the credential (cross-site WebSocket hijacking).",
        "ControlClient attaching the credential to a URL, query string, or log instead of only the Authorization header."
      ],
      paths: ["src/ControlRpcs.ts", "src/ControlServer.ts", "src/ControlClient.ts"]
    },
    {
      id: "sql-parameterization",
      title: "Control SQL binds every value as a parameter",
      threat:
        "A caller-controlled run id, flow id, filter, or cursor injects SQL and reads or rewrites another run's control rows.",
      lookFor: [
        "sql.literal, sql.unsafe, or string concatenation in SqlControlRuntime or the migrations carrying any value derived from ListRequest, WatchFilter, or a cursor.",
        "A column or ORDER BY fragment chosen from request text rather than from a fixed branch."
      ],
      paths: ["src/SqlControlRuntime.ts", "src/SqlCredentialStore.ts", "src/migrations/**"]
    },
    {
      id: "mutation-input-bounds",
      title: "Untrusted mutation and query input is bounded and inert before canonicalization or storage",
      threat:
        "A bearer holder or webhook caller crashes or stalls the control plane with oversized, deep, or getter-laden input.",
      lookFor: [
        "A Control mutation (plan, run, steer, signal, cancel) that canonicalizes, clones, or stores input before MutationBoundary.admit.",
        "A list or watch request with an unbounded page size, filter array, or recursion depth (human_wait_ancestry without maxWaitTreeDepth).",
        "JSON.parse of stored payload_json or a base64 wait token without try/catch or a size bound."
      ],
      paths: [
        "src/internal/MutationBoundary.ts",
        "src/ControlLive.ts",
        "src/SqlControlRuntime.ts",
        "src/ControlExecutor.ts",
        "src/ControlSchema.ts"
      ]
    },
    {
      id: "run-data-exposure",
      title: "List, watch, and health output reveal only what the caller may see",
      threat:
        "A bearer holder or dashboard viewer reads flow inputs, steer text, agent output tails, or credentials of runs they did not start.",
      lookFor: [
        "List or Watch projections that include raw flow input, signal payloads, or steer message bodies without redaction.",
        "Health exposing a session outputTail when the binding did not set exposeOutput: true.",
        "A ControlError or Unauthorized message that echoes input values, credential ids, or tokens."
      ],
      paths: ["src/ControlLive.ts", "src/Steering.ts", "src/Health.ts", "src/Monitor.ts", "src/ControlError.ts"]
    },
    {
      id: "jev-output-injection",
      title: "Agent session output sent to the evaluator cannot steer control decisions",
      threat:
        "A compromised agent writes text into its own output tail that makes the evaluator report it working, hiding that it is waiting on a credential or approval.",
      lookFor: [
        "JevSessionChecker passing more than jevStateTailCharacters, or passing the tail as instructions rather than as state data.",
        "A health report from the evaluator that changes run state, approvals, or cancellations rather than only an advisory activity label."
      ],
      paths: ["src/JevSessionChecker.ts", "src/Health.ts", "src/Monitor.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
