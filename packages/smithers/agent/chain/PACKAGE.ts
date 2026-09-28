import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * The seven standard targets are exactly what the root `packageDefaults`
 * macro synthesized for this directory before this file existed, so declaring
 * them changes nothing about what CI runs: `Smithers.PackageDefaults` applies
 * `BuildAndCheckTypeScriptPackage` with `cwd` set to the package directory, and stops
 * synthesizing for a directory that declares its own targets. The package
 * manager comes from the workspace declaration either way. Compare
 * `smithers-build query '//packages/smithers/agent/chain/...'` before and after.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/agent/chain"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/agent/chain",
  include: ["src/**", "prompts/**", "scripts/**"],
  checks: [
    {
      id: "quickjs-realm-seal",
      title: "A model-authored script reaches the host only through ctx.call",
      threat:
        "A model or prompt-injected author escapes the QuickJS realm and runs code or reads data in the host process.",
      lookFor: [
        "A host function other than the __call bridge exposed on the realm global, or __call/__encodeOutcome left reachable after the prelude runs.",
        "Script text interpolated into wrap() so it can close the async wrapper and reassign globalThis.__script, bypassing __encodeOutcome.",
        "A handle (deferred, scriptHandle, error) used after dispose, or a host exception from a bridge callback escaping as a defect instead of a typed ScriptFailure.",
        "Date or Math.random still reachable in the realm, or a prelude intrinsic read after the script could replace it."
      ],
      paths: ["src/QuickJsRunner.ts", "src/internal/QuickJsJobs.ts"]
    },
    {
      id: "in-process-runner-trusted-only",
      title: "The in-process Function runner never executes model-authored text",
      threat:
        "A model-authored script run by layerInProcess gets full host-realm access to process, require, globals, and credentials.",
      lookFor: [
        "A production layer or export path that selects ScriptRunner.layerInProcess instead of QuickJsRunner.layer.",
        "Docs or README text presenting layerInProcess as safe for untrusted scripts."
      ],
      paths: ["src/ScriptRunner.ts", "src/index.ts"]
    },
    {
      id: "json-boundary-single-read",
      title: "Every value crossing script, handler, and journal passes one single-read JSON copy",
      threat:
        "A script or handler smuggles a getter, proxy, toJSON hook, __proto__ key, or oversized value past the boundary and changes what the host journals or executes.",
      lookFor: [
        "A property read twice between validation and use, or a validated copy discarded in favor of the original object.",
        "Chain.executeCall passing the raw payload to entry.handler while journaling the validated jsonPayload copy.",
        "The in-realm copyJson and host jsonBoundary disagreeing on depth, size, holes, -0, or prototype checks.",
        "A key assigned with = instead of Object.defineProperty on a copy that has Object.prototype."
      ],
      paths: ["src/JsonBoundary.ts", "src/QuickJsRunner.ts", "src/ScriptRunner.ts", "src/Chain.ts"]
    },
    {
      id: "authorize-every-live-call",
      title: "Every live catalog and author call is authorized against its declared capabilities",
      threat:
        "A model-authored script invokes a catalog entry or spawns a sub-agent that the operator's Permission rules deny or require approval for.",
      lookFor: [
        "A live call path in Chain.executeCall that dispatches entry.handler or author.author before authorizeSlot.",
        "An undeclared entry (capabilities undefined) not defaulting to the broadest claim \"*\".",
        "evaluatePattern letting a partial or later allow lower a deny that still covers part of a wildcard claim.",
        "An unparseable claim treated as allow, or authorize_unavailable swallowed instead of failing the run.",
        "A sub-chain spawned through the agent entry running without the parent's Authorize service."
      ],
      paths: ["src/Authorize.ts", "src/Chain.ts", "src/SubChains.ts", "src/AuthorDeclaration.ts", "src/Catalog.ts"]
    },
    {
      id: "replay-identity",
      title: "A settled result replays only for the same link, script digest, ordinal, name, payload, and declaration",
      threat:
        "A script or redeclared catalog entry reuses another call's journaled result, skipping a side effect's authorization or receiving a stale privileged result.",
      lookFor: [
        "A replay path that skips comparing scriptDigest, name, canonical payload, or entryDigest before returning prior.result.",
        "A To outcome whose digest is taken from the script instead of re-derived by Outcome.to.",
        "Catalog.entryDigest ignoring capabilities when a host digest override is set, so widening a claim does not re-key calls.",
        "RegistryCatalog running a Markdown flow without re-checking the declaration digest at call time."
      ],
      paths: [
        "src/Chain.ts",
        "src/CallKey.ts",
        "src/Event.ts",
        "src/Outcome.ts",
        "src/Catalog.ts",
        "src/RegistryCatalog.ts",
        "src/JsonBoundary.ts"
      ]
    },
    {
      id: "journal-scope-isolation",
      title: "A chain reads and writes only its own journal scope",
      threat:
        "A child or sibling chain's events are folded into another chain, letting one agent settle, steer, or terminate another agent's run.",
      lookFor: [
        "A fold in Event.ts or Chain.ts that omits the inChain(event, chainId) filter.",
        "A root chain id containing / or <digits>.<digits> accepted, aliasing a derived child scope.",
        "Child scope derivation in SubChains that two slots can map to the same string, or a depth check a crafted slot can bypass.",
        "Chain.append absorbing another writer's events on journal_conflict instead of failing."
      ],
      paths: ["src/Chain.ts", "src/Event.ts", "src/SubChains.ts", "src/Journal.ts", "src/internal/childRun.ts"]
    },
    {
      id: "resource-budgets",
      title: "Scripts and chains are bounded in steps, memory, stack, calls, links, and depth",
      threat:
        "A model-authored script or recursive agent spawn exhausts host CPU, memory, or model spend for the operator.",
      lookFor: [
        "defaultLimits allowing memoryBytes, steps, or stackBytes to be unset in the production layer, or stackBytes above stackCeiling.",
        "A live call that bypasses the maxCallsPerLink fuel check, or a link loop that ignores maxLinks.",
        "SubChains maxDepth not counted from derived segments, allowing unbounded nested Chain.run.",
        "An observation, steering, or context string appended to the author prompt without the 8192/32768 truncation."
      ],
      paths: ["src/QuickJsRunner.ts", "src/Chain.ts", "src/SubChains.ts", "src/Observation.ts"]
    },
    {
      id: "prompt-catalog-injection",
      title: "Repository and tool text reaches the author model only as bounded, labelled data",
      threat:
        "A repository flow description, tool result, or steering line injects instructions that make the author model call privileged entries.",
      lookFor: [
        "A catalog description rendered without untrustedDescription quoting, truncation, and backtick removal.",
        "An entry name advertised that renderableName would reject, or advertised differently from what Catalog.lookup dispatches.",
        "Script.extract accepting more than one flow fence, or text outside the fence becoming script.",
        "Host prose or prompts/*.mdx promising a capability the catalog does not enforce."
      ],
      paths: [
        "src/Prompt.ts",
        "src/RegistryCatalog.ts",
        "src/Script.ts",
        "src/Author.ts",
        "src/Steering.ts",
        "src/internal/prompts.ts",
        "prompts/**"
      ]
    },
    {
      id: "memory-bank-scope",
      title: "The remember and recall entries only reach the banks the host's memory policy allows",
      threat:
        "A model-authored or prompt-injected script names another bank in its payload and reads or overwrites another agent's or user's memories.",
      lookFor: [
        "MemoryEntries binding Flows.runRemember or runRecall, which resolve the payload's bank without the policy check validatePolicyBank applies.",
        "A catalog shared across chains or tenants that captures one MemoryStore and Recall service at make time.",
        "Remembered facts written with empty provenance, so a poisoned memory cannot be traced to the chain, link, and call that wrote it."
      ],
      paths: ["src/MemoryEntries.ts"]
    },
    {
      id: "journal-secret-leak",
      title: "Handler failures and envelopes do not journal or prompt secrets",
      threat:
        "A handler or model-route error carrying a credential or private data is journaled verbatim and shown to the model and anyone who reads the journal.",
      lookFor: [
        "A CallError or model error message copied into an Observation or AuthorError without redaction.",
        "Options.envelope or goal carrying tokens that ChainStarted journals verbatim.",
        "MemoryEntries or ModelAuthor surfacing a store or route implementation error message beyond its code."
      ],
      paths: [
        "src/Chain.ts",
        "src/MemoryEntries.ts",
        "src/ModelAuthor.ts",
        "src/internal/failureCode.ts",
        "src/Observation.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
