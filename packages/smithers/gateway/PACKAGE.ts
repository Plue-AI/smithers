import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/gateway"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/gateway",
  include: ["src/**", "scripts/**"],
  checks: [
    {
      id: "bind-fails-closed",
      title: "A non-loopback or bridge-enabled gateway never starts without --listen and a bearer credential",
      threat:
        "Anyone on a shared network launches, cancels, or approves runs on a developer's workspace through an unauthenticated gateway.",
      lookFor: [
        "A path through bindRefusal or listenOptions that admits a host outside loopbackHostNames when listen !== true or credential is empty.",
        "layerAuth choosing layerNoopAuth while the bind host is not loopback, or isLoopbackHost trusting a spelling such as 0.0.0.0, ::, or 127.0.0.1.nip.io.",
        "A Bun or Node adapter that binds options it did not first pass through the shared listenOptions policy.",
        "A runtimeBridge enabled with credential undefined or empty, or the non-null credential assertion in makeLayer reachable without it."
      ],
      paths: ["src/internal/NativeGateway.ts", "src/bun/**", "src/node/**"]
    },
    {
      id: "ingress-host-origin",
      title:
        "Host and Origin checks stop browser pages and DNS rebinding from reaching the credential-free loopback gateway",
      threat:
        "A malicious web page the developer visits drives the local operator's control plane through DNS rebinding or cross-origin requests.",
      lookFor: [
        "requestAuthority or browserRequestRefusal accepting a Host header whose hostname is not in allowedHosts, or a loopbackOnly gateway accepting a non-loopback Host.",
        "An Origin header that is present but not http(s) with the exact Host authority and port, and still reaches a mount, including on a WebSocket upgrade.",
        "A request path, such as GET /health or a 404, that runs before the Host/Origin check and returns non-identity data.",
        "ingressOptions adding a wildcard bind (0.0.0.0 or ::) or an attacker-controlled name to allowedHosts."
      ],
      paths: ["src/GatewayServer.ts", "src/internal/NativeGateway.ts"]
    },
    {
      id: "edge-auth-path-aliases",
      title: "Every alias the router resolves to a protected mount is authenticated and body-bounded first",
      threat:
        "An unauthenticated network caller reads projections, sync state, or opens /rpc/ws and /runtime/v1 sockets by spelling the path so routedPath misses it.",
      lookFor: [
        "A spelling (percent-encoding, ;params, duplicate slashes, dot segments, case, backslash) that HttpRouter routes to a mount while routedPath returns a string outside protectedPaths or boundedPostPaths.",
        "A new HttpRouter.add or RpcServer mount path that is not listed in protectedPaths, rpcPaths, or boundedPostPaths.",
        "The authorize callback skipped for a protected path when options.authorize is set, or run after the body is read."
      ],
      paths: ["src/GatewayServer.ts", "src/RuntimeBridge.ts"]
    },
    {
      id: "principal-stamped-by-server",
      title: "Every mutation records the server-authenticated principal, never a client-supplied one",
      threat:
        "A bearer holder or bridge caller records approvals, signals, steers, or cancels under another operator's identity, forging the audit trail.",
      lookFor: [
        "Approval.Submit or RuntimeBridge.execute passing a principal, requestedBy, or identity field decoded from the request payload instead of ControlPrincipal or config.authenticate.",
        "A spread of client input (such as input.approval or input.steer) placed after principal so a client field overwrites it.",
        "A RuntimeBridge route that runs a command or observation before config.authenticate succeeds."
      ],
      paths: ["src/GatewayServer.ts", "src/RuntimeBridge.ts", "src/GatewayRpcs.ts"]
    },
    {
      id: "human-wait-answer-routing",
      title:
        "An answer or approval reaches only the wait the payload proves, and a question is never granted by a bare approve",
      threat:
        "A caller answers or approves a different run's gate, or resumes a HumanTask with no answer, by editing the target runId, digest, or decision.",
      lookFor: [
        "Approval.Submit signalling a runId or wait name taken from input without ControlExecutor.answerableWait deriving it from the target digest.",
        "A deny or answer-less approve on an answerable wait that falls through to control.approve or control.deny.",
        "humanWaitRow or approvals building a submit payload whose digest or idempotencyKey is not bound to the observed wait token, letting two parks share one decision."
      ],
      paths: ["src/GatewayServer.ts", "src/GatewayProjection.ts", "src/GatewayRpcs.ts"]
    },
    {
      id: "bridge-launch-provenance",
      title:
        "The runtime bridge launches only flows whose artifact digest, source revision, and owner generation match the host",
      threat:
        "A stale or compromised product backend launches a flow built from a different source revision or through a superseded owner process.",
      lookFor: [
        "execute reaching control.plan or control.run before validateOwner and the runtimeArtifactDigest and sourceRevision comparisons.",
        "plannedSource falling back to a request-supplied or environment-supplied revision instead of plan.graph.sourceRevision or verifiedCatalogSourceRevision.",
        "idempotencyKey built from fields a caller can vary to replay a completed launch or decision under a new key."
      ],
      paths: ["src/RuntimeBridge.ts"]
    },
    {
      id: "error-and-log-sanitization",
      title: "Wire errors carry only stable codes and tags, never backend messages, SQL, paths, or credentials",
      threat:
        "Any bearer holder, or a browser behind the product relay, reads storage paths, SQL diagnostics, executor output, or the bearer token from an error frame or log line.",
      lookFor: [
        "A GatewayError, BridgeError, or ErrorResponse built with a cause's message, stack, or nested cause instead of summarize or the stable code.",
        "bindFailure, mapServeError, or the Bun catchCause copying host, port, or errno onto the wire error rather than only the operator log.",
        "An Effect.log call that logs request headers, the credential, or a full request body."
      ],
      paths: [
        "src/GatewayError.ts",
        "src/Projections.ts",
        "src/RuntimeBridge.ts",
        "src/internal/NativeGateway.ts",
        "src/bun/**"
      ]
    },
    {
      id: "read-path-resource-bounds",
      title:
        "Every request body, event scan, page, subscription, and projection stays under its declared byte and count limit",
      threat:
        "An authenticated client or a run emitting huge events exhausts gateway memory or CPU and takes down the workspace control plane.",
      lookFor: [
        "A body read in layerIngress or RuntimeBridge.readJson without HttpServerRequest.MaxBodySize, or a route outside boundedPostPaths that reads a body.",
        "A control.watch or control.list stream in Projections or RuntimeBridge.observe consumed without Stream.take or a limit clamp such as maximumEventLimit.",
        "A projection fold, subscription follower set, or digest index that grows past maxEventsPerRun, maxProjectionBytes, or maxWorkspaceRuns without evicting or failing with resource_limit.",
        "A client-supplied limit or cursor that reaches Number arithmetic unclamped."
      ],
      paths: [
        "src/GatewayServer.ts",
        "src/Projections.ts",
        "src/RuntimeBridge.ts",
        "src/internal/digestIndex.ts",
        "src/internal/digestMemory.ts"
      ]
    },
    {
      id: "projection-output-integrity",
      title: "A run's final output and approval rows come only from committed, bound root facts",
      threat:
        "A child flow or forged telemetry event makes the product show, or the bridge return, a result or approval the root run never committed.",
      lookFor: [
        "nativeResolution.output returning text when binding and result disagree, conflict is set, or the event came from a non-root execution.",
        "A projection row that trusts event.payload fields (flowName, status, finalOutput) without the version and executionId checks fromEvent applies.",
        "RuntimeBridge.observe returning finalOutput when the snapshot row's runId, planDigest, or status differs from the listed summary."
      ],
      paths: [
        "src/internal/nativeResolution.ts",
        "src/internal/NativeGateway.ts",
        "src/GatewayProjection.ts",
        "src/Projections.ts",
        "src/RuntimeBridge.ts"
      ]
    },
    {
      id: "trace-verdict-provenance",
      title:
        "Run trace and diagnosis verdicts come only from the root run's control records, never from agent-authored payload text",
      threat:
        "An agent's cell output or a child run's journal records make the run card or diagnosis show a run as completed, passed, or failed when the root run's control journal says otherwise.",
      lookFor: [
        "A control.run.completed, failed, or cancelled record whose runId differs from the traced run still setting state.verdict, a pin, or accumulator.status.",
        "A verdict, status, or sufficiency note derived from payload fields (message, cause, failed, passed, flow) that a cell-printed or model-settled record can supply.",
        "A fold over journal records with no cap on records, spans, notes, or refusalCounts, so a run that emits many records exhausts the viewer."
      ],
      paths: [
        "src/RunTrace.ts",
        "src/Diagnosis.ts",
        "src/EngineTrace.ts",
        "src/internal/callEvents.ts",
        "src/internal/nodeEvents.ts"
      ]
    },
    {
      id: "health-probe-identity-only",
      title: "The unauthenticated GET /health answers identity only",
      threat:
        "An unauthenticated network caller learns tokens, run ids, prompts, or filesystem paths from the health probe.",
      lookFor: [
        "A field added to Health or RuntimeBridge.Identity that carries a credential, run, path, or environment value.",
        "layerHealth serving anything other than the fixed encoded Health value."
      ],
      paths: ["src/GatewayServer.ts", "src/GatewaySchema.ts", "src/RuntimeBridge.ts"]
    },
    {
      id: "mutation-script-exec",
      title: "The boundary-mutation script runs only fixed commands on fixed files",
      threat:
        "A contributor's environment or file contents inject commands into the pnpm/vitest subprocess the script spawns on a developer or CI machine.",
      lookFor: [
        "spawnSync called with shell: true or with arguments built from environment variables or file contents.",
        "Generated config code that interpolates values without JSON.stringify."
      ],
      paths: ["scripts/**"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
