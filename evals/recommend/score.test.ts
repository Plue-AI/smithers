import { describe, expect, test } from "bun:test";
import {
  count,
  FELL_THROUGH_BUCKET,
  NO_MODEL,
  NO_REPO,
  parseLog,
  percent,
  PILL_BUCKET,
  RecommendLogError,
  renderFrontDoor,
  renderPerModel,
  renderTable,
  ROUTED_BUCKET,
  scoreLog,
  type RecommendLogRow,
} from "./score.ts";

let sequence = 0;
function row(
  repo: string | null,
  commands: string[],
  outcome: string | null,
  overrides: Partial<RecommendLogRow> = {},
): RecommendLogRow {
  sequence += 1;
  return {
    id: `rec_${sequence}`,
    at: "2026-09-06T09:00:00.000Z",
    repo,
    tailDigest: "0".repeat(64),
    commandCount: 10,
    commands,
    model: "gpt-oss-120b",
    outcome: outcome === null ? null : { command: outcome, at: "2026-09-06T09:00:42.000Z" },
    ...overrides,
  };
}

describe("scoreLog", () => {
  test("a hit is any offered command, top-1 only the first, and a miss is neither", () => {
    const score = scoreLog([
      row("a/b", ["flow.list", "repo.open", "runs.list"], "flow.list"),
      row("a/b", ["flow.list", "repo.open", "runs.list"], "runs.list"),
      row("a/b", ["flow.list", "repo.open", "runs.list"], "keys.list"),
    ]);
    expect(score.rows).toBe(3);
    expect(score.withOutcome).toBe(3);
    expect(score.hits).toBe(2);
    expect(score.top1).toBe(1);
    expect(score.coverage).toBe(1);
    expect(score.hitRate).toBe(2 / 3);
    expect(score.top1Rate).toBe(1 / 3);
  });

  test("a row without an outcome lowers coverage and touches no rate", () => {
    const withOutcomes = scoreLog([row("a/b", ["flow.list"], "flow.list"), row("a/b", ["flow.list"], "runs.list")]);
    const withPending = scoreLog([
      row("a/b", ["flow.list"], "flow.list"),
      row("a/b", ["flow.list"], "runs.list"),
      row("a/b", ["flow.list"], null),
      row("a/b", ["flow.list"], null),
    ]);
    expect(withPending.rows).toBe(4);
    expect(withPending.withOutcome).toBe(2);
    expect(withPending.coverage).toBe(0.5);
    expect(withPending.hitRate).toBe(withOutcomes.hitRate);
    expect(withPending.top1Rate).toBe(withOutcomes.top1Rate);
  });

  test("an empty offered list can only miss", () => {
    const score = scoreLog([row("a/b", [], "flow.list")]);
    expect(score.withOutcome).toBe(1);
    expect(score.hits).toBe(0);
    expect(score.hitRate).toBe(0);
    expect(score.top1Rate).toBe(0);
  });

  test("an empty log reports null rates, not zero", () => {
    const score = scoreLog([]);
    expect(score.rows).toBe(0);
    expect(score.coverage).toBeNull();
    expect(score.hitRate).toBeNull();
    expect(score.top1Rate).toBeNull();
    expect(score.perRepo).toEqual({});
  });

  test("a log with rows but no outcomes has coverage 0 and null rates", () => {
    const score = scoreLog([row("a/b", ["flow.list"], null)]);
    expect(score.coverage).toBe(0);
    expect(score.hitRate).toBeNull();
    expect(score.top1Rate).toBeNull();
  });

  test("buckets rows per repository, sorted, with the no-repo bucket last", () => {
    const score = scoreLog([
      row("zeta/z", ["flow.list"], "flow.list"),
      row(null, ["flow.list"], "runs.list"),
      row("alpha/a", ["flow.list", "repo.open"], "repo.open"),
      row("alpha/a", ["flow.list"], null),
    ]);
    expect(Object.keys(score.perRepo)).toEqual(["alpha/a", "zeta/z", NO_REPO]);
    expect(score.perRepo["alpha/a"]).toEqual({
      rows: 2,
      withOutcome: 1,
      hits: 1,
      top1: 0,
      coverage: 0.5,
      hitRate: 1,
      top1Rate: 0,
    });
    expect(score.perRepo[NO_REPO].hits).toBe(0);
    expect(score.perRepo["zeta/z"].top1).toBe(1);
    // The overall bucket is the sum of the per-repo buckets.
    const summed = Object.values(score.perRepo).reduce((total, bucket) => total + bucket.withOutcome, 0);
    expect(score.withOutcome).toBe(summed);
  });

  test("reports k as the contract's list cap", () => {
    expect(scoreLog([]).k).toBe(5);
  });
});

describe("parseLog", () => {
  const good = JSON.stringify({
    id: "rec_1",
    at: "2026-09-06T09:00:00.000Z",
    repo: null,
    tailDigest: "0".repeat(64),
    commandCount: 3,
    commands: ["flow.list"],
    model: "gpt-oss-120b",
    outcome: null,
  });

  test("reads one row per line and skips blank lines", () => {
    const rows = parseLog(`\n${good}\n\n${good.replace("rec_1", "rec_2")}\n`);
    expect(rows.map((entry) => entry.id)).toEqual(["rec_1", "rec_2"]);
    expect(rows[0].repo).toBeNull();
    expect(rows[0].outcome).toBeNull();
  });

  test("names the line of a malformed row", () => {
    expect(() => parseLog(`${good}\nnot json\n`)).toThrow(RecommendLogError);
    expect(() => parseLog(`${good}\nnot json\n`)).toThrow(/^line 2: not JSON/);
    expect(() => parseLog(`${good}\n\n${good.replace("\"id\":\"rec_1\"", "\"id\":\"\"")}`)).toThrow(/^line 3: id must be/);
  });

  test("refuses an outcome without a command and a list longer than the cap", () => {
    const badOutcome = good.replace("\"outcome\":null", "\"outcome\":{\"at\":\"x\"}");
    expect(() => parseLog(badOutcome)).toThrow(/rec_1: outcome must be null or \{ command, at \}/);
    const tooLong = good.replace("[\"flow.list\"]", JSON.stringify(["a", "b", "c", "d", "e", "f"]));
    expect(() => parseLog(tooLong)).toThrow(/rec_1: commands has 6 entries; the contract allows at most 5/);
    const notStrings = good.replace("[\"flow.list\"]", "[1]");
    expect(() => parseLog(notStrings)).toThrow(/commands must be an array of strings/);
  });

  test("keeps the outcome's command and time", () => {
    const withOutcome = good.replace(
      "\"outcome\":null",
      "\"outcome\":{\"command\":\"flow.list\",\"at\":\"2026-09-06T09:00:42.000Z\"}",
    );
    expect(parseLog(withOutcome)[0].outcome).toEqual({ command: "flow.list", at: "2026-09-06T09:00:42.000Z" });
  });
});

describe("rendering", () => {
  test("count is singular and plural safe", () => {
    expect(count(0, "row")).toBe("no rows");
    expect(count(1, "row")).toBe("1 row");
    expect(count(2, "row")).toBe("2 rows");
  });

  test("percent prints one decimal and n/a for an empty denominator", () => {
    expect(percent(null)).toBe("n/a");
    expect(percent(0)).toBe("0.0%");
    expect(percent(2 / 3)).toBe("66.7%");
    expect(percent(1)).toBe("100.0%");
  });

  test("the table leads with the overall line and follows with one line per repo", () => {
    const table = renderTable(scoreLog([row("a/b", ["flow.list"], "flow.list"), row(null, ["flow.list"], null)]));
    const lines = table.trimEnd().split("\n");
    expect(lines[0]).toBe("recommend eval: 2 rows, 1 with an outcome");
    expect(lines[2]).toMatch(/^bucket\s+rows\s+outcome\s+coverage\s+hit@5\s+top-1$/);
    expect(lines[3]).toMatch(/^overall\s+2\s+1\s+50\.0%\s+100\.0%\s+100\.0%$/);
    expect(lines[4]).toMatch(/^a\/b\s+1\s+1\s+100\.0%\s+100\.0%\s+100\.0%$/);
    expect(lines[5]).toMatch(/^\(no repo\)\s+1\s+0\s+0\.0%\s+n\/a\s+n\/a$/);
    expect(lines.length).toBe(6);
  });

  test("the model table scores each model apart, so one model's rows read against another's", () => {
    const table = renderPerModel([
      row("a/b", ["flow.list"], "flow.list", { model: "jev-latest" }),
      row("a/b", ["flow.list"], "run.start", { model: "jev-latest" }),
      row("a/b", ["run.start"], "run.start", { model: "gpt-oss-120b" }),
      row("a/b", ["run.start"], "run.start", { model: "" }),
    ]);
    const lines = table.trimEnd().split("\n");
    expect(lines[0]).toBe("recommend eval by model");
    expect(lines[3]).toMatch(/^gpt-oss-120b\s+1\s+1\s+100\.0%\s+100\.0%\s+100\.0%$/);
    expect(lines[4]).toMatch(/^jev-latest\s+2\s+2\s+100\.0%\s+50\.0%\s+50\.0%$/);
    expect(lines[5]).toContain(NO_MODEL);
    expect(lines.length).toBe(6);
  });

  test("the door table reads the front door's routed turns apart from the composer's pills", () => {
    const table = renderFrontDoor([
      row("a/b", ["flow.list"], "flow.list"),
      row("a/b", ["runs.list"], null, {
        model: "typesafe-ai/jev",
        frontDoor: { confidence: 0.97, impossible: "none", routed: true },
      }),
      row("a/b", [], null, {
        model: "typesafe-ai/jev",
        frontDoor: { confidence: 0.4, impossible: "email", routed: false },
      }),
    ]);
    const lines = table.trimEnd().split("\n");
    expect(lines[0]).toBe("recommend eval by door");
    expect(lines[3]).toContain(PILL_BUCKET);
    expect(lines[4]).toContain(ROUTED_BUCKET);
    expect(lines[5]).toContain(FELL_THROUGH_BUCKET);
    expect(lines.length).toBe(6);
  });

  test("a front-door field a deployment never wrote, or wrote malformed, reads as an ordinary pill row", () => {
    const rows = parseLog(
      [
        JSON.stringify({ ...row("a/b", ["flow.list"], null), frontDoor: { confidence: "high" } }),
        JSON.stringify({
          ...row("a/b", ["flow.list"], null),
          frontDoor: { confidence: 0.9, impossible: "none", routed: true },
        }),
      ].join("\n"),
    );
    expect(rows[0].frontDoor).toBeUndefined();
    expect(rows[1].frontDoor).toEqual({ confidence: 0.9, impossible: "none", routed: true });
  });

  test("an empty log renders as empty", () => {
    const table = renderTable(scoreLog([]));
    expect(table.split("\n")[0]).toBe("recommend eval: no rows");
    expect(table).toMatch(/overall\s+0\s+0\s+n\/a\s+n\/a\s+n\/a/);
  });
});

describe("hostile log values", () => {
  test("a repo named __proto__ keeps its own per-repo bucket", () => {
    const score = scoreLog([row("__proto__", ["flow.list"], "flow.list"), row("a/b", ["flow.list"], "runs.list")]);
    expect(Object.keys(score.perRepo)).toEqual(["__proto__", "a/b"]);
    expect(Object.getPrototypeOf(score.perRepo)).toBe(Object.prototype);
    expect(score.perRepo["__proto__"]?.rows).toBe(1);
    expect(renderTable(score)).toMatch(/^__proto__\s+1\s+1/m);
    expect(JSON.parse(JSON.stringify(score)).perRepo).toHaveProperty(["__proto__", "rows"], 1);
  });

  test("control characters in repo and model names are escaped, never written raw", () => {
    const repo = "evil\u001b]52;c;aGk=\u0007/\u009b2J";
    const model = "m\u001b[2J\r\n";
    const rows = [row(repo, ["flow.list"], "flow.list", { model })];
    const rendered = renderTable(scoreLog(rows)) + renderPerModel(rows);
    expect(rendered).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(rendered).toContain("evil\\x1b]52;c;aGk=\\x07/\\x9b2J");
    expect(rendered).toContain("m\\x1b[2J\\x0d\\x0a");
  });
});
