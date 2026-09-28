import { describe, expect, test } from "bun:test";
import { Effect, Result, Stream } from "effect";
import * as Cell from "../../packages/smithers/agent/harness/src/Cell.ts";
import { readFileSync } from "node:fs";
import * as SeatResolver from "../../packages/smithers/agent/src/SeatResolver.ts";
import { addedLines, readPrompt, replacedLines, reviewDiff } from "./deterministicReviewer.ts";
import { loadCorpus } from "./labels.ts";
import { scriptedModel, scriptedSeats } from "./scriptedSeats.ts";

describe("scriptedSeats", () => {
  test("preserves distinct seat aliases while sharing one scripted model identity", async () => {
    const aliases = ["review", "review-verify", "review-narrate", "review-quiz"];
    const seats = await Effect.runPromise(
      Effect.gen(function* () {
        const resolver = yield* SeatResolver.SeatResolver;
        return yield* Effect.all(aliases.map((id) => resolver.resolve(id)));
      }).pipe(Effect.provide(scriptedSeats(() => []))),
    );

    expect(seats.map((seat) => seat.id)).toEqual(aliases);
    expect(new Set(seats.map((seat) => seat.id)).size).toBe(4);
    expect(new Set(seats.map((seat) => seat.modelId))).toEqual(new Set(["scripted-reviewer"]));
    expect(new Set(seats.map((seat) => seat.model)).size).toBe(1);
  });
});

const diff = [
  "--- a/src/order.ts",
  "+++ b/src/order.ts",
  "@@ -5,7 +5,7 @@",
  " };",
  " ",
  " export async function captureOrder(orderId: string) {",
  "-  const charge = await gateway.charge(orderId);",
  "+  const charge = gateway.charge(orderId);",
  "   if (!charge.ok) {",
].join("\n");

describe("addedLines", () => {
  test("numbers added lines from the hunk's new-side start", () => {
    expect(addedLines(diff)).toEqual([{ line: 8, text: "  const charge = gateway.charge(orderId);" }]);
  });

  test("skips the file headers rather than reading them as additions", () => {
    expect(addedLines(diff).some((added) => added.text.startsWith("+ b/"))).toBe(false);
  });
});

describe("replacedLines", () => {
  test("pairs a removed line with the added line that took its place", () => {
    expect(replacedLines(diff)).toEqual([
      {
        line: 8,
        before: "  const charge = await gateway.charge(orderId);",
        after: "  const charge = gateway.charge(orderId);",
      },
    ]);
  });

  test("pairs nothing across a context line", () => {
    const separated = ["@@ -1,4 +1,4 @@", "-const a = 1;", " const b = 2;", "+const c = 3;"].join("\n");
    expect(replacedLines(separated)).toEqual([]);
  });
});

describe("reviewDiff", () => {
  test("reports a dropped await, anchored to the line that dropped it", () => {
    const findings = reviewDiff("src/order.ts", diff);
    expect(findings).toHaveLength(1);
    expect(findings[0].startLine).toBe(8);
    expect(findings[0].severity).toBe("major");
    expect(findings[0].content).toContain("await");
  });

  test("reports interpolation into a SQL string", () => {
    const sql = ["@@ -1,1 +1,1 @@", "+  const rows = db.query(`SELECT * FROM users WHERE id = ${id}`);"].join("\n");
    const findings = reviewDiff("src/db.ts", sql);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("security");
    expect(findings[0].severity).toBe("critical");
  });

  test("reports a condition holding a term and its own negation", () => {
    const contradiction = ["@@ -1,1 +1,1 @@", "+  if (!result.cancelled && result.cancelled) {"].join("\n");
    expect(reviewDiff("src/assert.ts", contradiction)).toHaveLength(1);
  });

  test("says nothing about an ordinary rename", () => {
    const rename = ["@@ -1,2 +1,2 @@", "-export const total = sum(items);", "+export const orderTotal = sum(items);"]
      .join("\n");
    expect(reviewDiff("src/total.ts", rename)).toEqual([]);
  });

  test("never reads the corpus labels", () => {
    // The reviewer's only input is the prompt. A reviewer that could see the
    // ground truth would score perfectly and measure nothing, so this pins the
    // structural guarantee: the module imports nothing and touches no file.
    const code = readFileSync(new URL("./deterministicReviewer.ts", import.meta.url), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/^\s*import\b/m);
    expect(code).not.toContain("readFileSync");
    expect(code).not.toContain("labels");
  });
});

describe("readPrompt", () => {
  test("recovers the path and the fenced diff the review action wrote", () => {
    const ask = [
      "You are a Smithers native code-review agent.",
      "Current file path: src/order.ts",
      "",
      "Unified diff:",
      "```diff",
      diff,
      "```",
    ].join("\n");
    const read = readPrompt(ask);
    expect(read?.path).toBe("src/order.ts");
    expect(read?.diff).toContain("@@ -5,7 +5,7 @@");
  });

  test("answers null for a prompt with no diff", () => {
    expect(readPrompt("Current file path: src/order.ts")).toBeNull();
  });
});

describe("the corpus", () => {
  test("loads sixteen labelled fixtures", () => {
    const labels = loadCorpus();
    expect(labels).toHaveLength(16);
    expect(labels.filter((label) => label.clean)).toHaveLength(4);
  });
});

describe("scriptedModel", () => {
  test("keeps a backtick run in the answer inside one cell", async () => {
    const value = [{ content: "```cell\nctx.call(1)\n``` and `x`" }];
    const events = await Effect.runPromise(
      Stream.runCollect(scriptedModel(() => value).stream({ system: [], messages: [] } as never)),
    );
    const text = Array.from(events)
      .flatMap((event) => (event.type === "text-delta" ? [event.text] : []))
      .join("");
    const extracted = Result.getOrThrow(Cell.extract(text));
    expect(extracted.blocks).toBe(1);
    const body = extracted.source.text.trim();
    expect(body.startsWith("ctx.done(") && body.endsWith(")")).toBe(true);
    expect(JSON.parse(body.slice("ctx.done(".length, -1))).toEqual(value);
  });
});
