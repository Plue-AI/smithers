import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import Review from "../../flow.ts";
import { layerMemory } from "../host.ts";
import { scriptedSeats } from "./scriptedSeats.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

/** A repository whose working tree changes `count` files against its first commit. */
function tempRepo(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "review-flow-"));
  tempDirs.push(dir);
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test User"]);
  run(["config", "commit.gpgsign", "false"]);
  mkdirSync(dirname(join(dir, "src/a.ts")), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(dir, `src/file${index}.ts`), `export const value${index} = ${index};\n`);
  }
  run(["add", "."]);
  run(["commit", "-m", "base"]);
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(dir, `src/file${index}.ts`),
      `export const value${index} = ${index};\nexport const next${index} = ${index + 1};\n`,
    );
  }
  return dir;
}

const finding = (path: string) => ({
  path,
  content: "The new binding shadows the old one.",
  severity: "major",
  category: "correctness",
  confidence: "confirmed",
  startLine: 2,
  endLine: 2,
  existingCode: "",
  suggestionCode: "",
  thinking: "",
});

/** The four answers the four seats give, keyed off what each was asked. */
function answerFor(options: { findingsFor?: (path: string) => boolean; refuse?: ReadonlySet<string> } = {}) {
  const refuse = options.refuse ?? new Set<string>();
  return (ask: string): unknown => {
    if (ask.includes("adjudicate code-review findings")) {
      if (refuse.has("verify")) return undefined;
      return { verdicts: [{ index: 0, verdict: "keep", reason: "the diff shows it" }] };
    }
    if (ask.includes("explain a change set to a reader")) {
      if (refuse.has("narrate")) return undefined;
      return {
        headline: "Two bindings",
        synopsis: "Each file gains a second export.",
        chapters: [
          {
            title: "The change",
            // A diff block naming a real changed file: without one,
            // `normalizeStory` rejects the story and falls back, which is the
            // 0.x invariant this fixture has to satisfy to be used at all.
            blocks: [
              { kind: "prose", text: "Each file gains one export." },
              { kind: "diff", path: "src/file0.ts", intro: "The new export." },
            ],
          },
        ],
      };
    }
    if (refuse.has("review")) return undefined;
    const path = /Review the following file: (\S+)/.exec(ask)?.[1]! ??
      /(src\/file\d+\.ts)/.exec(ask)?.[1]! ??
      "";
    const wanted = options.findingsFor === undefined || options.findingsFor(path);
    return { status: "success", message: "", summary: null, comments: wanted ? [finding(path)] : [], warnings: [] };
  };
}

type ReviewOverrides = Partial<Parameters<typeof Review.execute>[0]>;

const runReview = (
  repo: string,
  input: ReviewOverrides,
  answer: (ask: string) => unknown,
) =>
  Effect.runPromise(
    Review.execute({ repo, ...input } as Parameters<typeof Review.execute>[0], {
      executionId: `review-test-${Math.random()}`,
    }).pipe(
      Effect.provide(layerMemory(scriptedSeats(answer))),
      Effect.orDie,
    ),
  );

describe("the review flow", () => {
  test("fans out over every changed file and reports one finding per file", async () => {
    const repo = tempRepo(3);
    const out = join(repo, "walkthrough.html");
    const result = await runReview(
      repo,
      { narrate: false, verify: false, out },
      answerFor(),
    );

    expect(result.review.status).toBe("success");
    expect(result.review.comments).toHaveLength(3);
    expect(result.review.comments.map((comment) => comment.path).sort()).toEqual([
      "src/file0.ts",
      "src/file1.ts",
      "src/file2.ts",
    ]);
    expect(result.walkthrough.findings).toBe(3);
    expect(readFileSync(out, "utf8")).toContain("<!doctype html>");
  }, 120_000);

  test("a finding that reports a failing command is a finding, not an invented claim", async () => {
    const repo = tempRepo(2);
    const content = "Running `pnpm test` fails on this branch because the export was renamed.";
    let asks = 0;
    const result = await runReview(
      repo,
      { narrate: false, verify: false, out: join(repo, "w.html") },
      (ask) => {
        const answer = answerFor()(ask) as { comments: Array<{ content: string }> };
        asks += 1;
        return { ...answer, comments: answer.comments.map((comment) => ({ ...comment, content })) };
      },
    );

    expect(result.review.status).toBe("success");
    expect(result.review.warnings).toEqual([]);
    expect(result.review.comments.map((comment) => comment.content)).toEqual([content, content]);
    expect(asks).toBe(2);
  }, 120_000);

  test.each([1, 2, 8])("bounds file-review calls at concurrency %i", async (concurrency) => {
    const repo = tempRepo(5);
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    // Hold the first calls open so the observed peak measures overlap.
    // After the initial observation, keep later calls open briefly as well.
    let draining = false;
    const release: (() => void)[] = [];
    /** Resolves once at least `count` calls have started. */
    const reached = (count: number) =>
      new Promise<void>((resolve) => {
        const poll = () => (started >= count ? resolve() : setTimeout(poll, 5));
        poll();
      });

    const pending = runReview(
      repo,
      { narrate: false, verify: false, concurrency, out: join(repo, "w.html") },
      async (ask) => {
        inFlight += 1;
        started += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => {
          if (draining) setTimeout(resolve, 25);
          else release.push(resolve);
        });
        inFlight -= 1;
        return answerFor()(ask);
      },
    );

    const expectedPeak = Math.min(concurrency, 5);
    await reached(expectedPeak);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const initiallyStarted = started;
    draining = true;
    for (const next of release.splice(0)) next();
    const result = await pending;

    expect(initiallyStarted).toBe(expectedPeak);
    expect(peak).toBe(expectedPeak);
    expect(started).toBe(5);
    expect(result.review.comments).toHaveLength(5);
    expect(result.review.comments.map((comment) => comment.path).sort()).toEqual([
      "src/file0.ts",
      "src/file1.ts",
      "src/file2.ts",
      "src/file3.ts",
      "src/file4.ts",
    ]);
  }, 120_000);

  test.each([
    ["review", undefined, 10],
    ["review", 1, 1],
    ["review", 2, 2],
    ["verify", 1, 1],
    ["narrate", 1, 1],
  ] as const)("interrupts the %s seat at timeout %s", async (seat, timeout, minutes) => {
    const repo = tempRepo(1);
    const marker = {
      review: "precise code reviewer",
      verify: "adjudicate code-review findings",
      narrate: "explain a change set to a reader",
    }[seat];
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let active = 0;
    let interrupted = 0;
    const result = await Effect.runPromise(Effect.gen(function*() {
      const pending = yield* Review.execute({
        repo,
        ...(timeout === undefined ? {} : { timeout }),
        verify: seat === "verify",
        narrate: seat === "narrate",
        out: join(repo, "w.html"),
      } as Parameters<typeof Review.execute>[0], {
        executionId: `review-timeout-${seat}-${minutes}`,
      }).pipe(
        Effect.provide(layerMemory(scriptedSeats((ask, signal) => {
          if (!ask.includes(marker)) return answerFor()(ask);
          active += 1;
          signal.addEventListener("abort", () => { active -= 1; interrupted += 1; }, { once: true });
          started();
          return new Promise<never>(() => {});
        }), process.env)),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => entered);
      yield* TestClock.adjust(minutes * 60_000 - 1);
      // The transport has its own five-minute retry budget. Even when a
      // previous attempt was interrupted, the action must remain active until
      // its own deadline and cancel whichever attempt is then in flight.
      expect(active).toBe(1);
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1);
      expect(active).toBe(0);
      expect(interrupted).toBeGreaterThan(0);
      return yield* Fiber.join(pending);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())));

    if (seat === "review") {
      expect(result.review.status).toBe("failed");
      expect(result.review.warnings).toContainEqual(expect.objectContaining({
        file: "src/file0.ts", type: "subtask_error",
      }));
    } else {
      expect(result.review.comments).toHaveLength(1);
      if (seat === "verify") {
        expect(result.review.warnings.some((warning) => warning.type === "verifier_error")).toBe(true);
        expect(result.review.status).toBe("completed_with_warnings");
        expect(result.review.warnings.find((warning) => warning.type === "verifier_error")?.message).toContain("smithers-review/VerifyFindings timed out");
      } else if (seat === "narrate") {
        expect(result.review.warnings.some((warning) => warning.type === "narrator_error")).toBe(true);
        expect(result.story.chapters.length).toBeGreaterThan(0);
        expect(result.story.headline).not.toBe("Two bindings");
    expect(result.review.status).toBe("completed_with_warnings");
    expect(result.review.warnings).toContainEqual(expect.objectContaining({ type: "narrator_error" }));
    expect(readFileSync(result.walkthrough.path, "utf8")).toContain("narrator_error");
      }
    }
    expect(result.walkthrough.path).toBe(join(repo, "w.html"));
  }, 120_000);

  test("a file review that fails becomes a warning, not a dead run", async () => {
    const repo = tempRepo(1);
    const result = await runReview(
      repo,
      { narrate: false, verify: false, out: join(repo, "w.html") },
      answerFor({ refuse: new Set(["review"]) }),
    );

    expect(result.review.status).toBe("failed");
    expect(result.review.warnings.some((warning) => warning.type === "subtask_error")).toBe(true);
    expect(result.walkthrough.path).toBe(join(repo, "w.html"));
  }, 120_000);

  test("a failed batch member does not prevent later batches from running", async () => {
    const repo = tempRepo(3);
    const started: string[] = [];
    const result = await runReview(
      repo,
      { narrate: false, verify: false, concurrency: 1, out: join(repo, "w.html") },
      (ask) => {
        const path = /(src\/file\d+\.ts)/.exec(ask)![1]!;
        started.push(path);
        return path === "src/file0.ts" ? undefined : answerFor()(ask);
      },
    );

    expect(started.sort()).toEqual(["src/file0.ts", "src/file1.ts", "src/file2.ts"]);
    expect(result.review.comments.map((comment) => comment.path).sort()).toEqual([
      "src/file1.ts",
      "src/file2.ts",
    ]);
    expect(result.review.warnings.some((warning) => warning.type === "subtask_error")).toBe(true);
    const html = readFileSync(result.walkthrough.path, "utf8");
    expect(html).toContain("Review incomplete or completed with warnings");
    const fileArticle = (path: string) => html.split(`data-path="${path}">`)[1]!.split("</article>")[0]!;
    expect(fileArticle("src/file0.ts")).toContain("not reviewed");
    expect(fileArticle("src/file1.ts")).not.toContain("not reviewed");
  }, 120_000);

  test("verification runs on the findings and its verdicts reach the walkthrough", async () => {
    const repo = tempRepo(1);
    const result = await runReview(
      repo,
      { narrate: false, verify: true, out: join(repo, "w.html") },
      (ask) =>
        ask.includes("adjudicate code-review findings")
          ? { verdicts: [{ index: 0, verdict: "drop", reason: "the diff refutes it" }] }
          : answerFor()(ask),
    );

    expect(result.review.comments).toHaveLength(0);
    expect(result.review.warnings.some((warning) => warning.type === "verifier_dropped")).toBe(true);
    expect(result.review.message).toContain("Verification dropped 1 finding");
  }, 120_000);

  test("a verifier that fails leaves the findings unverified rather than failing the review", async () => {
    const repo = tempRepo(1);
    const result = await runReview(
      repo,
      { narrate: false, verify: true, out: join(repo, "w.html") },
      answerFor({ refuse: new Set(["verify"]) }),
    );

    expect(result.review.comments).toHaveLength(1);
    expect(result.review.warnings.some((warning) => warning.type === "verifier_error")).toBe(true);
    expect(result.review.status).toBe("completed_with_warnings");
    expect(readFileSync(result.walkthrough.path, "utf8")).toContain("unverified");
  }, 120_000);

  test("the narrator's story reaches the rendered walkthrough", async () => {
    const repo = tempRepo(1);
    const out = join(repo, "w.html");
    const result = await runReview(repo, { narrate: true, verify: false, out }, answerFor());

    expect(result.story.headline).toBe("Two bindings");
    expect(result.walkthrough.chapters).toBeGreaterThan(0);
    expect(readFileSync(out, "utf8")).toContain("Two bindings");
  }, 120_000);

  test("a narrator that fails falls back to the deterministic story", async () => {
    const repo = tempRepo(1);
    const result = await runReview(
      repo,
      { narrate: true, verify: false, out: join(repo, "w.html") },
      answerFor({ refuse: new Set(["narrate"]) }),
    );

    expect(result.review.comments).toHaveLength(1);
    expect(result.story.chapters.length).toBeGreaterThan(0);
    expect(result.story.headline).not.toBe("Two bindings");
    expect(result.review.status).toBe("completed_with_warnings");
    expect(result.review.warnings).toContainEqual(expect.objectContaining({ type: "narrator_error" }));
    expect(readFileSync(result.walkthrough.path, "utf8")).toContain("narrator_error");
  }, 120_000);

  test("--no-review skips the seats and reports the skipped status", async () => {
    const repo = tempRepo(2);
    const result = await runReview(
      repo,
      { runReview: false, narrate: false, verify: false, out: join(repo, "w.html") },
      () => {
        throw new Error("no seat should be asked for a --no-review run");
      },
    );

    expect(result.review.status).toBe("skipped");
    expect(result.review.comments).toHaveLength(0);
    expect(result.walkthrough.files).toBe(2);
  }, 120_000);
});


test.each(["non-repo", "bad-ref", "unwritable-output"] as const)("typed failures: %s", async (kind) => {
  const repo = kind === "non-repo" ? mkdtempSync(join(tmpdir(), "review-not-repo-")) : tempRepo(1);
  if (kind === "non-repo") tempDirs.push(repo);
  const blocker = join(repo, "blocker");
  if (kind === "unwritable-output") writeFileSync(blocker, "file");
  const input = {
    repo, runReview: false, narrate: false, verify: false,
    out: kind === "unwritable-output" ? join(blocker, "w.html") : join(repo, "w.html"),
    ...(kind === "bad-ref" ? { from: "missing-review-ref", to: "HEAD" } : {}),
  };
  let failure: unknown;
  try {
    await Effect.runPromise(Review.execute(input, { executionId: `typed-${crypto.randomUUID()}` }).pipe(
      Effect.provide(layerMemory(scriptedSeats(() => { throw new Error("unexpected model call"); }), process.env)),
    ));
  } catch (error) { failure = error; }
  expect((failure as { _tag: string })._tag).toBe(
    kind === "unwritable-output" ? "smithers-review/WalkthroughUnwritable" : "smithers-review/ChangeSetUnreadable",
  );
  expect(typeof (failure as Error).message).toBe("string");
  if (kind === "bad-ref") expect((failure as Error).message).toContain("missing-review-ref");
});
