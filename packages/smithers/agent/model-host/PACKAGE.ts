import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Shared model host library targets and its coverage-gated protocol suite. */
import { Smithers } from "@smthrs/targets"
import { Package as rpcPackage } from "../../../rpc/PACKAGE.ts"
import { Package as kernelPackage } from "../../flows/kernel/PACKAGE.ts"
import { Package as modelPackage } from "../model/PACKAGE.ts"

const cwd = "packages/smithers/agent/model-host"
const dependencies = [kernelPackage.lib, modelPackage.lib, rpcPackage.check]
const standard = BuildAndCheckTypeScriptPackage({ deps: dependencies, cwd })

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "host-bearer-auth",
      title: "Every turn and stream request presents the host bearer before any body is read or model is called",
      threat: "An unauthenticated network caller spends the owner's provider credential or drives turns on the host.",
      lookFor: [
        "A path other than /health in createModelTurnHandler that reaches boundedJson, resolve or runModelTurn before authorized().",
        "An authorization comparison that is not constant time or accepts an empty or whitespace-only configured secret.",
        "A body size check that trusts content-length alone instead of the decoded byte count."
      ],
      paths: ["src/HostServer.ts"]
    },
    {
      id: "grant-wire-validation",
      title: "A durable turn grant is strictly decoded, unexpired and pinned to the configured callback origin",
      threat:
        "A caller holding the host bearer makes the host send grant tokens or frames to an origin they control, or commit to another run's journal.",
      lookFor: [
        "decodeGrant accepting a producerBaseUrl that differs from the normalized callbackBaseUrl, or with userinfo, query or fragment.",
        "A grant whose request.runId, cursor.runId or cursor.legId is not checked against the grant's runId and legId.",
        "An expired or unparseable expiresAt that still yields a grant."
      ],
      paths: ["src/HostServer.ts", "src/DurableChatProducer.ts"]
    },
    {
      id: "stream-path-owner-trust",
      title: "The sealed stream endpoint never takes owner identity or model binding from the request body",
      threat:
        "A caller with the shared host bearer runs a turn as another owner or against a model and credential that owner did not configure.",
      lookFor: [
        "The MODEL_HOST_STREAM_PATH branch reading ownerId from the JSON body and passing it into the resolver grant.",
        "environmentModelResolver preferring grant.request.model over the configured binding without the planner pinning origin and credential.",
        "A fixed placeholder grant token or cursor on the stream path that a resolver could treat as a real durable grant."
      ],
      paths: ["src/HostServer.ts", "src/EnvironmentResolver.ts"]
    },
    {
      id: "credential-egress-pinning",
      title:
        "A provider credential is read by one planned name and sent only to its planned origin with redirects refused",
      threat: "A crafted model binding exfiltrates the owner's provider API key to an attacker-chosen URL.",
      lookFor: [
        "A credential read from env or ModelCredentials before planModelBinding succeeds, or under a name other than plan.credential.",
        "A fetch used for a provider call that does not set redirect: 'manual', letting a 3xx carry the key header to another origin (environmentModelResolver's guardedFetch defaults to plain globalThis.fetch).",
        "A Route or Endpoint built from a baseUrl or path that did not come from the validated ModelPlan."
      ],
      paths: ["src/EnvironmentResolver.ts", "src/LocalModel.ts", "src/ConfiguredModelRoute.ts", "src/ModelProbe.ts"]
    },
    {
      id: "credential-output-redaction",
      title: "Model output, tool calls, samples and errors never echo the provider credential or provider text",
      threat:
        "A prompt-injected or malicious provider reflects the owner's API key into frames, logs or HTTP responses the renderer and other users see.",
      lookFor: [
        "A text, reasoning, tool name or tool argument emission that bypasses StreamingCredentialCutter or cutModelCredential.",
        "StreamingCredentialCutter emitting a secret prefix split across chunks, or finish() skipping the cut.",
        "A log annotation, ModelHostError message or HTTP error body that includes a cause, provider message or URL."
      ],
      paths: [
        "src/ModelTurnHost.ts",
        "src/ModelProbe.ts",
        "src/LocalModel.ts",
        "src/HostServer.ts",
        "src/ModelHostError.ts"
      ]
    },
    {
      id: "probe-egress-policy",
      title: "A model Test dials only the planned origin, and only loopback when the host has no egress",
      threat:
        "A caller of the model Test endpoint makes the host send an owner credential to, or probe, an internal or attacker-chosen URL.",
      lookFor: [
        "createModelProbe planning with options other than { egress: false } when options.egress is false, so the offline host reaches a non-loopback origin.",
        "A decision or generation call in ModelProbe that runs outside the manualRedirects layer or ignores http.redirected() before returning success.",
        "Caller-composed ModelCallInput (prompt, system, questions, maxTokens) reaching the provider without the rpc schema's size and count bounds."
      ],
      paths: ["src/ModelProbe.ts", "src/LocalModel.ts", "src/ConfiguredModelRoute.ts"]
    },
    {
      id: "journal-receipt-fencing",
      title: "Each committed frame is hash-checked against the expected cursor before the producer advances",
      threat:
        "A compromised or confused producer endpoint forks or rewrites a user's durable chat transcript without detection.",
      lookFor: [
        "DurableChatProducer.write advancing this.cursor when the reply batch, from, previousHash or hash does not match the locally computed digest.",
        "A retry that re-sends a frame under a stale cursor after a CommitRefused fence loss."
      ],
      paths: ["src/DurableChatProducer.ts"]
    },
    {
      id: "untrusted-turn-shape",
      title: "Renderer-supplied messages and tools are shape-checked before becoming a provider request",
      threat:
        "A caller injects system-role content or malformed tool schemas that crash the host or override owner instructions.",
      lookFor: [
        "turnRequest or streamRequest casting a body to StartAgentTurnRequest without checking message roles, tool names or parameter objects.",
        "appendWireMessage mapping an unknown role or item type to a system or tool message.",
        "Unbounded frame buffering on the stream path that lets one request hold the whole model output in memory."
      ],
      paths: ["src/HostServer.ts", "src/ModelTurnHost.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check: standard.check,
    docs: standard.docs,
    docsFiles: standard.docsFiles,
    fmt: standard.fmt,
    lib: standard.lib,
    lint: standard.lint,
    test: standard.test,
    ...securityReview
  }
})
