import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { ReviewTagsMigrationsAndKeys } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/flows/journal"
})

/**
 * The durable-identity review: identity strings, migrations, persisted
 * schemas, and durable keys, read out of this package's own changed sources.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/journal" })

/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every included file.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/journal",
  include: ["src/**", "docs/**"],
  checks: [
    {
      id: "journal-payload-redaction",
      title: "Every durable journal event payload and meta passes the redactor before it is encoded and stored",
      threat:
        "Any sync subscriber or time-travel reader of a run reads a flow author's API keys or tokens replayed forever from flows_journal_events.",
      lookFor: [
        "A write path (emitLossy, emitDurable, emitDurableUnfenced, transact) that encodes payload or meta into payload_json/meta_json without calling the configured redact first.",
        "An idempotency or fingerprint comparison computed over the raw rather than the redacted value, so a reused source event stores or echoes unredacted text.",
        "A default that resolves to Redaction.makeNoop instead of Redaction.make when options.redact is omitted."
      ],
      paths: ["src/SqlJournal.ts", "src/Journal.ts"]
    },
    {
      id: "redaction-rule-coverage",
      title: "Redaction rules and sensitive-key suffixes catch every credential shape they claim and stay linear-time",
      threat:
        "A caller logging or journaling a credential leaks it to durable rows, stderr, or OTLP, or a crafted string hangs the journal write path with regex backtracking.",
      lookFor: [
        "A regex in defaultRules with nested quantifiers or alternation inside a repetition that backtracks super-linearly on a long hostile string.",
        "A credential field name (for example clientSecret, refreshToken, x-api-key, privateKey) that isSensitiveKey returns false for.",
        "A redact branch (toJSON, binary views, proxies, __proto__ keys, array species, symbols, functions) that returns caller text without running the rules over it.",
        "redactJsonString returning the original parsed text when the redactor throws."
      ],
      paths: ["src/Redaction.ts"]
    },
    {
      id: "logger-redaction",
      title:
        "The redacting logger redacts message, cause, annotations, stack frames, and console output before any logger reads them",
      threat:
        "An action that logs a token leaks it to the operator's terminal, the .flows/logs file, or an OTLP collector via Logger.tracerLogger.",
      lookFor: [
        "A console method in consoleMethods marked false that still prints a caller-supplied argument or label.",
        "An Error copy that carries an inherited getter, prototype hook, symbol key, or cause without passing it through the redactor.",
        "A fallback path (catch block, unrenderable marker) that prints String(value) of the unredacted input.",
        "A Cause reason, StackTrace, or InterruptorStackTrace annotation forwarded to the wrapped logger without redaction."
      ],
      paths: ["src/RedactedLogger.ts"]
    },
    {
      id: "owner-fence",
      title: "Fenced durable appends and checkpoints commit only while the caller still holds the run's owner fence",
      threat:
        "A stale or rival process on the same database appends events or overwrites checkpoints of a run another process now owns, corrupting its replay.",
      lookFor: [
        "An INSERT into flows_journal_events or flows_journal_checkpoints, or a compaction DELETE, on an Owned fence that is not preceded by Consensus.guard inside the same write transaction.",
        "A SqlConsensus lease statement whose owner or claim predicate omits one of owner_host_id, owner_pid, owner_nonce (or the claim tuple and claimed_at_ms), or a steal that skips the heartbeat staleness cutoff.",
        "A public method that reaches the Unfenced fence without being emitDurableUnfenced or a documented internal path.",
        "Owner fields matched loosely (empty hostId or nonce accepted as a wildcard)."
      ],
      paths: ["src/SqlJournal.ts", "src/OwnerId.ts", "src/Consensus.ts", "src/SqlConsensus.ts"]
    },
    {
      id: "sql-parameterization",
      title: "Every journal SQL statement binds caller values as parameters",
      threat: "A caller-controlled runId, sourceId, eventType, or limit injects SQL into the journal database.",
      lookFor: [
        "sql.unsafe, string concatenation, or a template interpolation of a caller value outside the sql tagged template or sql.in.",
        "A Dialect helper (indexHint, greatest) fed a caller-controlled string rather than a constant.",
        "A LIMIT or cursor value that is not validated as a bounded safe integer before it reaches the query."
      ],
      paths: ["src/SqlJournal.ts", "src/migrations/**", "src/Migrations.ts"]
    },
    {
      id: "run-isolation",
      title: "Every journal read, dedup lookup, compaction, and delete stays inside the caller's run id",
      threat:
        "A flow whose run id or source id collides with another run's persisted key reads, dedupes into, or deletes that other run's events.",
      lookFor: [
        "A SELECT, DELETE, or UPDATE on flows_journal_events, flows_journal_checkpoints, or flows_journal_dedup whose WHERE clause lacks run_id and matches on event_id or seq alone, returning another run's row.",
        "A change to makeEventId that drops the length prefixes, so two distinct (runId, sourceId, sourceSeq) triples mint the same event_id.",
        "An identifier schema that stops rejecting lone surrogates, NUL, or over-length text, letting two decoded ids land on one stored key.",
        "A sourceEvents or sourceSequences cache key built without the run id, or a JournalGeneration.forget that invalidates runs it was not given."
      ],
      paths: ["src/SqlJournal.ts", "src/JournalEvent.ts", "src/JournalGeneration.ts", "src/migrations/**"]
    },
    {
      id: "journal-resource-bounds",
      title: "Journal reads, writes, and in-memory caches stay bounded under hostile input",
      threat:
        "A flow emitting huge or deeply nested payloads, or a reader requesting huge pages, exhausts memory or stack in the process that hosts every run.",
      lookFor: [
        "A read page limit not capped by maxEntriesLimit, or a stream that buffers an unbounded run history.",
        "A redact or canonicalize walk without the maxDepth cap that recurses on a caller value.",
        "sourceEvents or sourceSequences caches that grow without eviction or truncation cleanup."
      ],
      paths: ["src/SqlJournal.ts", "src/Redaction.ts"]
    },
    {
      id: "compaction-integrity",
      title: "Compaction and checkpoints never let a replay silently skip or re-use truncated sequences",
      threat:
        "A reader resyncing after compaction gets a shortened history, or a restarted writer reallocates a deleted sequence and a duplicate event is accepted as new.",
      lookFor: [
        "A read whose cursor is below the compaction floor that returns rows instead of failing with compacted.",
        "Compaction that deletes events without recording the producer identities in the dedup table first.",
        "A checkpoint accepted for a seq with no committed entry or at or below the compaction floor."
      ],
      paths: ["src/SqlJournal.ts", "src/JournalGeneration.ts", "src/migrations/**"]
    },
    {
      id: "docs-redaction-claims",
      title: "Docs never promise redaction the code does not perform or ship a real credential in an example",
      threat:
        "A user copying a docs snippet stores secrets in checkpoint state_json believing it is redacted, or a published doc leaks a live key.",
      lookFor: [
        "A guide stating checkpoint state, errors, or run state_json are redacted, contrary to Redaction.ts.",
        "An example that uses Redaction.makeNoop on a shared store without warning.",
        "A token-shaped string in docs that is not an obvious placeholder."
      ],
      paths: ["docs/**"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, reviewTagsMigrationsAndKeys, fmt, lib, lint, test, ...securityReview }
})
