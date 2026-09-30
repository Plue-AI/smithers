import type { D1Database } from "../d1.ts";
import { modelPrices } from "./modelPrices.ts";
import type { UsageSummary } from "./parseUsage.ts";

export interface RecordedUsage {
  costUsd: number;
  recorded: boolean;
}

/**
 * Commit the debit, the per-(repo, model) rollup bump, and the idempotent
 * ledger event together, retaining interrupted-call holds. The rollup feeds
 * /metrics so a scrape never re-aggregates the event log.
 */
export async function recordUsage(
  db: D1Database,
  options: {
    /** Generated once at admission, reused for every settlement retry. */
    requestId: string;
    sessionHash: string | null;
    repo: string;
    pr: number;
    summary: UsageSummary;
    kind: "messages" | "messages_stream" | "other";
    now: number;
    /** Interrupted inference records observed spend but keeps its conservative hold. */
    retainReservation?: boolean;
  },
): Promise<RecordedUsage> {
  const counts = [
    options.summary.inputTokens,
    options.summary.outputTokens,
    options.summary.cacheCreationTokens,
    options.summary.cacheReadTokens,
  ];
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error("invalid usage token count");
  // Anthropic reports cache tokens beside input_tokens; the long-context
  // threshold reads the whole prompt. `now` keeps settlement retries
  // deterministic across a dated successor flip.
  const price = modelPrices(options.summary.model, {
    promptTokens: options.summary.inputTokens + options.summary.cacheCreationTokens + options.summary.cacheReadTokens,
    at: options.now,
  });
  const costUsd =
    (options.summary.inputTokens * price.input +
      options.summary.outputTokens * price.output +
      options.summary.cacheCreationTokens * price.cacheWrite +
      options.summary.cacheReadTokens * price.cacheRead) /
    1_000_000;
  // Persist the retry payload before attempting settlement. Failure of the batch
  // leaves this payload AND the budget hold intact for the next repo request.
  await db
    .prepare("UPDATE usage_reservations SET settlement_json = COALESCE(settlement_json, ?) WHERE id = ?")
    .bind(JSON.stringify(options), options.requestId)
    .run();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE sessions SET spent_usd = spent_usd + ? WHERE hash = ?
      AND NOT EXISTS (SELECT 1 FROM usage_events WHERE id = ?)`,
      )
      .bind(costUsd, options.sessionHash, options.requestId),
    db
      .prepare(
        `INSERT INTO usage_totals (repo, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usage_events WHERE id = ?)
      ON CONFLICT(repo, model) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cost_usd = cost_usd + excluded.cost_usd`,
      )
      .bind(options.repo, options.summary.model, ...counts, costUsd, options.requestId),
    db
      .prepare(
        `INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        options.requestId,
        options.repo,
        options.pr,
        options.summary.model,
        ...counts,
        costUsd,
        options.kind,
        options.now,
      ),
    db
      .prepare(
        options.retainReservation
          ? "UPDATE usage_reservations SET settlement_json = NULL WHERE id = ?"
          : "DELETE FROM usage_reservations WHERE id = ?",
      )
      .bind(options.requestId),
  ]);
  return { costUsd, recorded: results[2].meta.changes === 1 };
}
