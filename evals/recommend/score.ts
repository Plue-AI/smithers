/**
 * Scores the command recommender from its log.
 *
 * One log row is one recommendation the server made: the ordered list of
 * commands it offered under the composer, and, once the user ran something,
 * the command they ran next. The scorer is a pure function over those rows.
 *
 * - `hit`: the command the user ran next was somewhere in the offered list.
 * - `top1`: it was the first entry, the pill the user saw first.
 * - `coverage`: the share of rows that have an outcome at all. A row without
 *   an outcome is a recommendation nobody acted on yet, and it counts toward
 *   nothing except coverage.
 *
 * Rates are `null` when their denominator is zero, and the renderer prints
 * `n/a` for them, so an empty log is reported as empty rather than as 0%.
 *
 * @since 1.0.0
 */

/** The maximum list length the server may return, and so the `k` in hit@k. */
export const RECOMMENDATION_LIMIT = 5;

/** The bucket a row with `repo: null` is scored under. */
export const NO_REPO = "(no repo)";

/** The bucket a row whose `model` is empty is scored under. */
export const NO_MODEL = "(no model)";

/** What the user ran after a recommendation, as the log records it. */
export interface RecommendOutcome {
  readonly command: string;
  readonly at: string;
}

/**
 * One recommendation as the server logs it. The scorer reads `id`, `repo`,
 * `commands`, and `outcome`; the remaining fields are carried through
 * untouched so a report can quote them.
 */
export interface RecommendLogRow {
  readonly id: string;
  readonly at: string;
  readonly repo: string | null;
  readonly tailDigest: string;
  readonly commandCount: number;
  readonly commands: ReadonlyArray<string>;
  readonly model: string;
  /**
   * Present only on a FRONT-DOOR row: the turn route asked Jev whether the
   * user's message simply IS a command, instead of the composer asking which
   * pill to show. Both kinds share one log, so `--live` reads them apart here
   * rather than through a second store.
   */
  readonly frontDoor?: FrontDoorDecision;
  readonly outcome: RecommendOutcome | null;
}

/** What one front-door read decided, as apps/server frontDoor.ts logs it. */
export interface FrontDoorDecision {
  readonly confidence: number;
  readonly impossible: string;
  /** Whether the Worker answered the turn itself, or fell through to the chat upstream. */
  readonly routed: boolean;
}

/** The bucket a row is scored under in the front-door table. */
export const PILL_BUCKET = "composer pill";
export const ROUTED_BUCKET = "front door (routed)";
export const FELL_THROUGH_BUCKET = "front door (fell through)";

/** The counts and rates for one bucket of rows. */
export interface BucketScore {
  readonly rows: number;
  readonly withOutcome: number;
  readonly hits: number;
  readonly top1: number;
  /** `withOutcome / rows`, or `null` when there are no rows. */
  readonly coverage: number | null;
  /** `hits / withOutcome`, or `null` when no row has an outcome. */
  readonly hitRate: number | null;
  /** `top1 / withOutcome`, or `null` when no row has an outcome. */
  readonly top1Rate: number | null;
}

/** The whole score: the overall bucket plus one bucket per repository. */
export interface RecommendScore extends BucketScore {
  readonly k: number;
  readonly perRepo: Readonly<Record<string, BucketScore>>;
}

/**
 * Thrown for a log line the contract does not allow. The message quotes log
 * values such as the row id, so it passes through `printable` before it can
 * reach a terminal.
 */
export class RecommendLogError extends Error {
  override readonly name = "RecommendLogError";
  readonly line: number;
  constructor(line: number, message: string) {
    super(`line ${line}: ${printable(message)}`);
    this.line = line;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks one parsed JSON value against the log row contract.
 *
 * @since 1.0.0
 */
export function asLogRow(value: unknown, line: number): RecommendLogRow {
  if (!isRecord(value)) throw new RecommendLogError(line, "a log row must be a JSON object");
  if (typeof value.id !== "string" || value.id === "") throw new RecommendLogError(line, "id must be a non-empty string");
  if (value.repo !== null && typeof value.repo !== "string") {
    throw new RecommendLogError(line, `${value.id}: repo must be a string or null`);
  }
  if (!Array.isArray(value.commands) || value.commands.some((entry) => typeof entry !== "string")) {
    throw new RecommendLogError(line, `${value.id}: commands must be an array of strings`);
  }
  if (value.commands.length > RECOMMENDATION_LIMIT) {
    throw new RecommendLogError(
      line,
      `${value.id}: commands has ${value.commands.length} entries; the contract allows at most ${RECOMMENDATION_LIMIT}`,
    );
  }
  let outcome: RecommendOutcome | null = null;
  if (value.outcome !== null && value.outcome !== undefined) {
    if (!isRecord(value.outcome) || typeof value.outcome.command !== "string" || typeof value.outcome.at !== "string") {
      throw new RecommendLogError(line, `${value.id}: outcome must be null or { command, at }`);
    }
    outcome = { command: value.outcome.command, at: value.outcome.at };
  }
  /*
   * A front-door row is read leniently: the scorer's own numbers never depend
   * on it, so a deployment that predates the field, or one whose field is
   * malformed, reads as an ordinary pill row rather than failing the pull.
   */
  const door = value.frontDoor;
  const frontDoor: FrontDoorDecision | undefined = isRecord(door) && typeof door.confidence === "number" &&
      typeof door.impossible === "string" && typeof door.routed === "boolean"
    ? { confidence: door.confidence, impossible: door.impossible, routed: door.routed }
    : undefined;
  return {
    id: value.id,
    at: typeof value.at === "string" ? value.at : "",
    repo: value.repo,
    tailDigest: typeof value.tailDigest === "string" ? value.tailDigest : "",
    commandCount: typeof value.commandCount === "number" ? value.commandCount : 0,
    commands: value.commands as ReadonlyArray<string>,
    model: typeof value.model === "string" ? value.model : "",
    ...(frontDoor === undefined ? {} : { frontDoor }),
    outcome,
  };
}

/**
 * Parses an exported log: one JSON object per line, blank lines ignored.
 *
 * @since 1.0.0
 */
export function parseLog(text: string): RecommendLogRow[] {
  const rows: RecommendLogRow[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new RecommendLogError(index + 1, `not JSON (${(error as Error).message})`);
    }
    rows.push(asLogRow(parsed, index + 1));
  }
  return rows;
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

function scoreBucket(rows: ReadonlyArray<RecommendLogRow>): BucketScore {
  let withOutcome = 0;
  let hits = 0;
  let top1 = 0;
  for (const row of rows) {
    if (row.outcome === null) continue;
    withOutcome += 1;
    if (row.commands.includes(row.outcome.command)) hits += 1;
    if (row.commands[0] === row.outcome.command) top1 += 1;
  }
  return {
    rows: rows.length,
    withOutcome,
    hits,
    top1,
    coverage: ratio(withOutcome, rows.length),
    hitRate: ratio(hits, withOutcome),
    top1Rate: ratio(top1, withOutcome),
  };
}

/**
 * Scores a log. Repositories are reported in sorted order, with the
 * `(no repo)` bucket last.
 *
 * @since 1.0.0
 */
export function scoreLog(rows: ReadonlyArray<RecommendLogRow>): RecommendScore {
  const byRepo = new Map<string, RecommendLogRow[]>();
  for (const row of rows) {
    const key = row.repo ?? NO_REPO;
    const bucket = byRepo.get(key);
    if (bucket === undefined) byRepo.set(key, [row]);
    else bucket.push(row);
  }
  const keys = [...byRepo.keys()].filter((key) => key !== NO_REPO).sort((left, right) => left.localeCompare(right));
  if (byRepo.has(NO_REPO)) keys.push(NO_REPO);
  /*
   * Object.fromEntries defines own properties, so a repository named
   * `__proto__` keeps its bucket instead of replacing the object's prototype.
   */
  const perRepo: Record<string, BucketScore> = Object.fromEntries(
    keys.map((key) => [key, scoreBucket(byRepo.get(key)!)]),
  );
  return { k: RECOMMENDATION_LIMIT, ...scoreBucket(rows), perRepo };
}

/** `1 row`, `2 rows`, `no rows`. */
export function count(value: number, singular: string, plural: string = `${singular}s`): string {
  if (value === 0) return `no ${plural}`;
  return `${value} ${value === 1 ? singular : plural}`;
}

/** A rate as a percentage with one decimal, or `n/a` for an empty denominator. */
export function percent(value: number | null): string {
  return value === null ? "n/a" : `${(Math.round(value * 1000) / 10).toFixed(1)}%`;
}

/**
 * Renders the score as a small fixed-width table, one line per bucket, with
 * the overall line first.
 *
 * @since 1.0.0
 */
export function renderTable(score: RecommendScore): string {
  const outcomes = score.withOutcome === 1 ? "1 with an outcome" : `${score.withOutcome} with an outcome`;
  const headline = score.rows === 0
    ? "recommend eval: no rows"
    : `recommend eval: ${count(score.rows, "row")}, ${outcomes}`;
  return renderBuckets(headline, score.k, [["overall", score], ...Object.entries(score.perRepo)]);
}

/**
 * The same table, one line per model the log names, so a live run reads one
 * model's hit rate against another's. The score object is untouched: the
 * baseline gates the scorer, and which models answered a deployment's rows is
 * not the scorer's behaviour.
 *
 * @since 1.0.0
 */
export function renderPerModel(rows: ReadonlyArray<RecommendLogRow>): string {
  const byModel = new Map<string, RecommendLogRow[]>();
  for (const row of rows) {
    const key = row.model === "" ? NO_MODEL : row.model;
    const bucket = byModel.get(key);
    if (bucket === undefined) byModel.set(key, [row]);
    else bucket.push(row);
  }
  const names = [...byModel.keys()].filter((name) => name !== NO_MODEL).sort((left, right) => left.localeCompare(right));
  if (byModel.has(NO_MODEL)) names.push(NO_MODEL);
  return renderBuckets("recommend eval by model", RECOMMENDATION_LIMIT, names.map((name) => [name, scoreBucket(byModel.get(name)!)]));
}

/**
 * The same table, split by which door made the row: the composer's pills, the
 * turns the front door answered itself, and the turns it read and let through
 * to the chat upstream. A live pull needs those apart — a routed turn replaced
 * an LLM turn, a pill only offered one — and the scorer's own numbers stay
 * untouched, exactly as the per-model table leaves them.
 *
 * @since 1.0.0
 */
export function renderFrontDoor(rows: ReadonlyArray<RecommendLogRow>): string {
  const bucketOf = (row: RecommendLogRow): string =>
    row.frontDoor === undefined ? PILL_BUCKET : row.frontDoor.routed ? ROUTED_BUCKET : FELL_THROUGH_BUCKET;
  const byDoor = new Map<string, RecommendLogRow[]>();
  for (const row of rows) {
    const key = bucketOf(row);
    const bucket = byDoor.get(key);
    if (bucket === undefined) byDoor.set(key, [row]);
    else bucket.push(row);
  }
  const order = [PILL_BUCKET, ROUTED_BUCKET, FELL_THROUGH_BUCKET].filter((name) => byDoor.has(name));
  return renderBuckets(
    "recommend eval by door",
    RECOMMENDATION_LIMIT,
    order.map((name) => [name, scoreBucket(byDoor.get(name)!)]),
  );
}

/**
 * Escapes C0 and C1 control characters as `\xNN`. Repository and model names
 * come from the log, which users and the deployment control, so a name must
 * never reach the terminal as an ANSI or OSC escape sequence.
 *
 * @since 1.0.0
 */
export function printable(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function renderBuckets(headline: string, k: number, raw: ReadonlyArray<[string, BucketScore]>): string {
  const buckets = raw.map(([name, bucket]): [string, BucketScore] => [printable(name), bucket]);
  const label = Math.max("bucket".length, ...buckets.map(([name]) => name.length), 0);
  const columns = ["rows", "outcome", "coverage", `hit@${k}`, "top-1"];
  const width = 9;
  const header = ["bucket".padEnd(label), ...columns.map((column) => column.padStart(width))].join("  ");
  const lines = buckets.map(([name, bucket]) =>
    [
      name.padEnd(label),
      String(bucket.rows).padStart(width),
      String(bucket.withOutcome).padStart(width),
      percent(bucket.coverage).padStart(width),
      percent(bucket.hitRate).padStart(width),
      percent(bucket.top1Rate).padStart(width),
    ].join("  ")
  );
  return [headline, "", header, ...lines, ""].join("\n");
}
