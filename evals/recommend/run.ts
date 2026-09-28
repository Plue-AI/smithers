/**
 * Scores the command recommender and gates the scorer on its baseline.
 *
 * Launch line, from the repository root:
 *
 * ```bash
 * bun evals/recommend/run.ts
 * ```
 *
 * Three modes, one per flag:
 *
 * - No flag: scores the checked-in fixture `fixtures/sample.jsonl` and
 *   compares the result with `baseline.json`. This is the CI run. It is
 *   offline and deterministic, so a red run means the scorer moved, not the
 *   model.
 * - `--input <file.jsonl>`: scores an exported log and prints the table. No
 *   baseline is consulted; the numbers are the model's, and they belong in a
 *   report, never in the baseline.
 * - `--live`: pulls the log from a deployment's admin surface, scores it, and
 *   prints the table, followed by a second table with one line per model the
 *   rows name and a third splitting the rows by the door that made them:
 *   the composer's pills, and the front door's routed and fell-through
 *   reads (apps/server frontDoor.ts). `SMITHERS_ORIGIN` names the deployment (default
 *   `https://smithers.sh`) and `SMITHERS_ADMIN_TOKEN` is the bearer the admin
 *   routes accept. The token is read from the environment and never printed.
 *   The origin must be `https:` (or `http:` on a loopback host), redirects
 *   are refused, and the body is capped at `LIVE_MAX_BYTES` and `LIVE_LIMIT`
 *   rows.
 *
 * `--update` rewrites `baseline.json` from the fixture. Do that only when the
 * scorer changed for a reason you can name. `--json` prints the score as JSON
 * instead of the table.
 *
 * stdout carries the score and nothing else: one table, or under `--json` one
 * JSON value, in every mode. Verdicts and paths are diagnostics and go to
 * stderr, so `run.ts --json | jq` parses whichever mode produced it.
 *
 * Exit codes: `0` scored, or matched the baseline; `1` the fixture's score
 * disagrees with the baseline; `2` the input could not be read or parsed;
 * `3` the live pull failed.
 *
 * @since 1.0.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseLog,
  printable,
  RecommendLogError,
  renderFrontDoor,
  renderPerModel,
  renderTable,
  scoreLog,
  type RecommendLogRow,
  type RecommendScore,
} from "./score.ts";

const here = import.meta.dirname;

/** The fixture the CI run scores. */
export const fixturePath = join(here, "fixtures", "sample.jsonl");
/** The committed score of the fixture. */
export const baselinePath = join(here, "baseline.json");

/** The environment the live pull reads. */
export const LIVE_ORIGIN_ENV = "SMITHERS_ORIGIN";
export const LIVE_TOKEN_ENV = "SMITHERS_ADMIN_TOKEN";
export const DEFAULT_ORIGIN = "https://smithers.sh";
/** The admin route the live pull reads, and the row cap it asks for. */
export const LOG_PATH = "/api/admin/recommend/log";
export const LIVE_LIMIT = 2000;
/** The largest response body the live pull reads before it gives up. */
export const LIVE_MAX_BYTES = 16 * 1024 * 1024;

export const usage = [
  "usage: bun evals/recommend/run.ts [--input <file.jsonl> | --live] [--update] [--json]",
  "",
  "Scores the command recommender: for every recommendation with an outcome,",
  "did the command the user ran next appear in the offered list (hit@5), and",
  "was it the first entry (top-1)? Coverage is the share of rows with an outcome.",
  "",
  "  (no flag)          score fixtures/sample.jsonl and gate it on baseline.json",
  "  --input <file>     score an exported log (JSON lines, one row per recommendation)",
  "  --live             pull the log from a deployment and score it",
  `                     reads ${LIVE_ORIGIN_ENV} (default ${DEFAULT_ORIGIN})`,
  `                     and ${LIVE_TOKEN_ENV} (the admin bearer; never printed)`,
  "  --update           rewrite baseline.json from the fixture",
  "  --json             print the score as JSON instead of a table",
  "  --help             print this text",
  "",
  "exit codes: 0 scored or matched the baseline, 1 baseline drift,",
  "            2 unreadable or malformed input, 3 live pull failed",
  "",
].join("\n");

/** The one call the live pull makes. Narrower than `typeof fetch` so a test can hand in a plain function. */
export type Fetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly redirect: "error" },
) => Promise<Response>;

/** What the program reads and writes. `main` takes one so a test can capture it. */
export interface Host {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch: Fetch;
}

const processHost: Host = {
  env: process.env,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  fetch: (input, init) => fetch(input, init),
};

/**
 * Canonical JSON for the baseline: sorted keys, two-space indent, trailing
 * newline. JSON.stringify escapes only U+0000 to U+001F, so U+007F to U+009F
 * (DEL and the C1 controls, including CSI) are escaped here as `\u00NN`.
 */
export function canonical(value: unknown): string {
  const sorted = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sorted);
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, sorted((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  const json = JSON.stringify(sorted(value), null, 2).replace(
    /[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${json}\n`;
}

function readRows(path: string, host: Host): RecommendLogRow[] | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    host.stderr(`could not read ${path}: ${(error as Error).message}\n`);
    return undefined;
  }
  try {
    return parseLog(text);
  } catch (error) {
    if (error instanceof RecommendLogError) {
      host.stderr(`${path}: ${error.message}\n`);
      return undefined;
    }
    throw error;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin the bearer may go to: `https:`, or `http:` on a loopback host
 * for a local server. Anything else would send the admin token in cleartext.
 */
function liveOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return raw.replace(/\/+$/, "");
  }
  return undefined;
}

/** Reads the body up to `limit` bytes; `undefined` once it grows past the limit. */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) return undefined;
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function pullRows(host: Host): Promise<RecommendLogRow[] | undefined> {
  const token = host.env[LIVE_TOKEN_ENV]?.trim();
  if (token === undefined || token === "") {
    host.stderr(`${LIVE_TOKEN_ENV} is unset; the live log is admin-only\n`);
    return undefined;
  }
  const origin = liveOrigin(host.env[LIVE_ORIGIN_ENV] ?? DEFAULT_ORIGIN);
  if (origin === undefined) {
    host.stderr(`${LIVE_ORIGIN_ENV} must be an https:// origin, or http:// on localhost; the bearer is never sent in cleartext\n`);
    return undefined;
  }
  const url = `${origin}${LOG_PATH}?limit=${LIVE_LIMIT}`;
  let response: Response;
  try {
    response = await host.fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
    });
  } catch (error) {
    host.stderr(`GET ${url} failed: ${(error as Error).message}\n`);
    return undefined;
  }
  if (!response.ok) {
    host.stderr(`GET ${url} answered ${response.status}\n`);
    return undefined;
  }
  let body: unknown;
  try {
    const text = await readCapped(response, LIVE_MAX_BYTES);
    if (text === undefined) {
      host.stderr(`GET ${url} answered more than ${LIVE_MAX_BYTES} bytes\n`);
      return undefined;
    }
    body = JSON.parse(text);
  } catch (error) {
    host.stderr(`GET ${url} did not answer JSON: ${printable((error as Error).message)}\n`);
    return undefined;
  }
  const rows = typeof body === "object" && body !== null ? (body as { rows?: unknown }).rows : undefined;
  if (!Array.isArray(rows)) {
    host.stderr(`GET ${url} answered without a rows array\n`);
    return undefined;
  }
  if (rows.length > LIVE_LIMIT) {
    host.stderr(`GET ${url} answered ${rows.length} rows; it asked for at most ${LIVE_LIMIT}\n`);
    return undefined;
  }
  try {
    return parseLog(rows.map((row) => JSON.stringify(row)).join("\n"));
  } catch (error) {
    if (error instanceof RecommendLogError) {
      host.stderr(`${url}: ${error.message}\n`);
      return undefined;
    }
    throw error;
  }
}

function report(score: RecommendScore, json: boolean, host: Host): void {
  host.stdout(json ? canonical(score) : renderTable(score));
}

/**
 * Runs the program. Returns the process exit code.
 *
 * @since 1.0.0
 */
export async function main(argv: readonly string[] = process.argv.slice(2), host: Host = processHost): Promise<number> {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    host.stdout(usage);
    return 0;
  }
  const json = args.includes("--json");
  const update = args.includes("--update");
  const live = args.includes("--live");
  const inputIndex = args.indexOf("--input");
  const input = inputIndex === -1 ? undefined : args[inputIndex + 1];
  if (inputIndex !== -1 && (input === undefined || input.startsWith("--"))) {
    host.stderr(`--input needs a file\n${usage}`);
    return 2;
  }
  const known = new Set(["--json", "--update", "--live", "--input"]);
  const unknown = args.filter((arg, index) => !known.has(arg) && !(index === inputIndex + 1 && inputIndex !== -1));
  if (unknown.length > 0) {
    host.stderr(`unknown argument: ${unknown[0]}\n${usage}`);
    return 2;
  }
  if (live && input !== undefined) {
    host.stderr(`--live and --input name two different logs; pass one\n`);
    return 2;
  }

  if (live) {
    const rows = await pullRows(host);
    if (rows === undefined) return 3;
    report(scoreLog(rows), json, host);
    if (!json) {
      host.stdout(renderPerModel(rows));
      host.stdout(renderFrontDoor(rows));
    }
    return 0;
  }

  if (input !== undefined) {
    const rows = readRows(input, host);
    if (rows === undefined) return 2;
    report(scoreLog(rows), json, host);
    return 0;
  }

  const rows = readRows(fixturePath, host);
  if (rows === undefined) return 2;
  const score = scoreLog(rows);
  const current = canonical(score);
  if (update) {
    writeFileSync(baselinePath, current);
    report(score, json, host);
    host.stderr(`recorded ${baselinePath}\n`);
    return 0;
  }
  let baseline: string;
  try {
    baseline = readFileSync(baselinePath, "utf8");
  } catch (error) {
    host.stderr(`could not read ${baselinePath}: ${(error as Error).message}\n`);
    return 2;
  }
  report(score, json, host);
  if (baseline === current) {
    host.stderr(`recommend: the fixture's score matches the baseline\n`);
    return 0;
  }
  host.stderr(
    `recommend: the fixture's score disagrees with ${baselinePath}\n` +
      "re-record with `bun evals/recommend/run.ts --update` only when the scorer changed on purpose\n",
  );
  return 1;
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  process.exitCode = await main();
}
