import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/agent/memory"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/agent/memory",
  include: ["src/**"],
  checks: [
    {
      id: "policy-bank-scope",
      title: "Model remember and recall stay inside the flow's memory policy namespace",
      threat:
        "A prompt-injected agent reads or overwrites another user's or the global memory bank by naming a foreign bank.",
      lookFor: [
        "A remember or recall path that resolves input.bank without validatePolicyBank when the flow carries a policy.",
        "runRemember or runRecall bound as a model-facing handler instead of handlersFor(boundFlow), which skips the policy entirely.",
        "namespaceForBank letting a crafted bank string such as \"user-x\" or \"global-\" alias a namespace the policy did not list."
      ],
      paths: ["src/Flows.ts", "src/WithMemory.ts", "src/internal/ResolveNamespace.ts", "src/Bank.ts"]
    },
    {
      id: "namespace-scoped-queries",
      title: "Every memory read, write, and delete filters on namespace kind and id",
      threat:
        "A caller holding one namespace reads, restatuses, or supersedes notes, facts, or threads of another namespace by guessing an id.",
      lookFor: [
        "A SELECT, UPDATE, or DELETE keyed only by id, thread_id, or fact_key with no namespace_kind and namespace_id predicate (e.g. getNote, setNoteStatus).",
        "A supersession edge or FTS or vector row written across namespaces."
      ],
      paths: [
        "src/internal/Notes.ts",
        "src/internal/Facts.ts",
        "src/internal/Threads.ts",
        "src/internal/Store.ts",
        "src/MemoryStore.ts"
      ]
    },
    {
      id: "sql-fragment-injection",
      title: "User text reaches SQL only as bound parameters",
      threat:
        "A model or user injects SQL or FTS5 syntax through a query, key, prefix, or bank to read or corrupt all memory rows.",
      lookFor: [
        "sql.literal or sql(...) identifier interpolation built from anything other than a Kind literal or constant column list.",
        "An FTS5 MATCH operand not produced by literalFtsQuery, or a Postgres tsquery built with to_tsquery on raw text."
      ],
      paths: ["src/internal/**", "src/RecallFts.ts", "src/RecallKeyword.ts", "src/RecallSemantic.ts"]
    },
    {
      id: "recalled-memory-fence",
      title: "Recalled memory rendered into agent context cannot escape its fence or forge labels",
      threat:
        "An attacker who planted a memory row injects instructions outside the flows_memory_context fence of a later agent's prompt.",
      lookFor: [
        "A character that opens a fence or label (<, [, newline, U+2028/2029) left unescaped in row text, bank, or key by escapeText or escapeLabel.",
        "A truncation in fit or the byte budget that splits an escape sequence or drops the closing fence."
      ],
      paths: ["src/Source.ts", "src/SnapshotRecorder.ts"]
    },
    {
      id: "untrusted-input-bounds",
      title: "Model-supplied recall and remember inputs are bounded before any I/O",
      threat: "A model or tenant exhausts CPU, memory, or database time for every tenant sharing the memory store.",
      lookFor: [
        "A tag group, bank list, query, key, text, or maxTokens accepted without the MAX_* caps before the store runs.",
        "A recursive walk or unbounded scan (vector pages, FTS paging loop) with no row or iteration ceiling."
      ],
      paths: ["src/Namespace.ts", "src/Recall.ts", "src/Flows.ts", "src/RecallSemantic.ts", "src/internal/Search.ts"]
    },
    {
      id: "embedding-provider-output",
      title: "Embedding provider responses are validated before storage or ranking",
      threat:
        "A faulty or hostile embedding provider poisons ranking or crashes recall for every namespace with NaN, sparse, or mis-sized vectors.",
      lookFor: [
        "A vector with non-finite, missing, or mismatched-dimension components stored or compared without rejection.",
        "Stored vector bytes decoded without a length check in VectorBytes."
      ],
      paths: ["src/Embedding.ts", "src/RecallSemantic.ts", "src/internal/VectorBytes.ts"]
    },
    {
      id: "model-write-provenance",
      title: "Model-written facts cannot pose as trusted-source memory",
      threat:
        "A prompt-injected agent calls remember with source: or scope: tags, or overwrites an existing key, so later recalls filtered by source trust its planted text.",
      lookFor: [
        "RememberInput.tags passed to putFact unfiltered, letting the model set source:, scope:, branch:, or stream: tags that recall filters treat as trusted.",
        "runRemember recording empty provenance, so a model-written fact is indistinguishable from an operator-written one.",
        "putFact replacing an existing fact key written by a different source without superseding or recording the prior author."
      ],
      paths: ["src/Flows.ts", "src/Namespace.ts", "src/Recall.ts", "src/internal/Facts.ts", "src/internal/Store.ts"]
    },
    {
      id: "ttl-and-retention",
      title: "Expired and retain-never memory is never returned or persisted",
      threat:
        "A later run recalls a fact the author set to expire or asked never to retain, leaking stale or sensitive data.",
      lookFor: [
        "A read path (facts, FTS, vector, keyword) that omits the ttl_ms expiry predicate.",
        "A remember path that writes when policy.retain is \"never\".",
        "Expired fact deletion that leaves its FTS or vector projection behind."
      ],
      paths: [
        "src/internal/Facts.ts",
        "src/Maintenance.ts",
        "src/Flows.ts",
        "src/RecallSemantic.ts",
        "src/internal/Fts.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
