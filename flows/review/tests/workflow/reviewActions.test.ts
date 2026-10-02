import { WalkthroughUnwritable } from "../../src/workflow/reviewFailureSchema.ts";
import * as renderer from "../../src/walkthrough/renderWalkthroughHtml.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Flow, Interpreter } from "@smthrs/flow";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { ApplyVerdicts, PrepareReview, RenderWalkthrough } from "../../src/workflow/reviewActions.ts";
import { ReviewRunOutput } from "../../src/workflow/reviewRunOutputSchema.ts";
import { host } from "../host.ts";
import { layer as implementations } from "../../flow.ts";
import { scriptedSeats } from "./scriptedSeats.ts";

const RenderTest = Flow.make("test/RenderWalkthrough", {
  payload: RenderWalkthrough.payloadSchema, success: RenderWalkthrough.successSchema, error: RenderWalkthrough.errorSchema,
  body: (payload) => RenderWalkthrough.call(payload),
});
const VerifyTest = Flow.make("test/ApplyVerdicts", {
  payload: ApplyVerdicts.payloadSchema, success: ApplyVerdicts.successSchema,
  body: (payload) => ApplyVerdicts.call(payload),
});
const PrepareTest = Flow.make("test/PrepareReview", {
  payload: PrepareReview.payloadSchema, success: PrepareReview.successSchema, error: PrepareReview.errorSchema,
  body: (payload) => PrepareReview.call(payload),
});
let writeFailure: "artifact" | "output" | undefined;
let injectedWriteFailure = false;
const guardedFs = Layer.unwrap(Effect.gen(function*() {
 const real = yield* FileSystem.FileSystem;
 return Layer.succeed(FileSystem.FileSystem, { ...real, writeFileString: (path, data, options) => {
  if (writeFailure && path.endsWith(".tmp") && (path.includes(".smithers-review-artifacts") === (writeFailure === "artifact"))) {
   injectedWriteFailure = true;
   return real.writeFileString(path, "partial", options).pipe(Effect.flatMap(() => Effect.die(new Error("disk full"))));
  }
  return real.writeFileString(path, data, options);
 } });
}));
const testLayer = () => Layer.merge(implementations, Layer.merge(
  Layer.merge(Interpreter.layer(RenderTest), Interpreter.layer(VerifyTest)),
  Interpreter.layer(PrepareTest),
)).pipe(
  Layer.provideMerge(guardedFs.pipe(Layer.provideMerge(host(scriptedSeats(() => undefined))))),
);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const review = Schema.decodeUnknownSync(ReviewRunOutput)({ status: "success", ok: true });

async function render(out: string, outcome: unknown = review) {
  return Effect.runPromise(RenderTest.execute(Schema.decodeUnknownSync(RenderWalkthrough.payloadSchema)({
    input: { repo: dirname(out), out },
    target: { repoDir: dirname(out), mode: "workspace", ref: "workspace" },
    changes: { files: [{ path: "a.ts", status: "modified", diff: "", reviewed: true }] },
    review: outcome, story: null,
  }), { executionId: `render-${crypto.randomUUID()}` }).pipe(
    Effect.provide(testLayer()),
  ));
}

function outputPath() {
  const dir = fs.mkdtempSync(join(tmpdir(), "review-artifact-"));
  dirs.push(dir);
  return join(dir, "walkthrough.html");
}

test("verifier failure promotes success and preserves findings", async () => {
  const result = await Effect.runPromise(VerifyTest.execute({ review, verdicts: null }, {
    executionId: `verify-${crypto.randomUUID()}`,
  }).pipe(Effect.provide(testLayer())));
  expect(result.status).toBe("completed_with_warnings");
  expect(result.comments).toEqual(review.comments);
  expect(result.warnings).toContainEqual(expect.objectContaining({ type: "verifier_error", message: expect.stringContaining("unverified") }));
});

test("render action carries failed review diagnostics into HTML", async () => {
  const out = outputPath();
  await render(out, { ...review, status: "failed", ok: false, warnings: [{ file: "a.ts", type: "subtask_error", message: "seat timed out" }] });
  const html = fs.readFileSync(out, "utf8");
  expect(html).toContain("Review failed");
  expect(html).toContain("seat timed out");
  expect(html).toContain("not reviewed");
  expect(html).not.toContain('findings <strong>0</strong>');
});

test("each render retains its own artifact when the user-facing output is replaced", async () => {
  const out = outputPath();
  const first = await render(out);
  const firstHtml = fs.readFileSync(out, "utf8");
  const second = await render(out, { ...review, status: "failed", ok: false });
  const artifact = first.walkthrough.artifactPath;
  expect(artifact).toBeString();
  expect(artifact).not.toBe(out);
  expect(artifact).not.toBe(second.walkthrough.artifactPath);
  expect(fs.readFileSync(artifact, "utf8")).toBe(firstHtml);
  expect(fs.readFileSync(out, "utf8")).not.toBe(firstHtml);
});

test.each(["artifact", "output"])("a partial %s write leaves the previous user-facing artifact intact", async (stage) => {
  const out = outputPath();
  fs.writeFileSync(out, "previous complete artifact");
  writeFailure = stage as "artifact" | "output";
  injectedWriteFailure = false;
  try {
    await expect(render(out)).rejects.toMatchObject({ _tag: "smithers-review/WalkthroughUnwritable", path: out, message: expect.stringContaining("disk full") });
  } finally { writeFailure = undefined; }
  expect(injectedWriteFailure).toBe(true);
  expect(fs.readFileSync(out, "utf8")).toBe("previous complete artifact");
  expect(fs.readdirSync(dirname(out), { recursive: true }).filter((name) => String(name).endsWith(".tmp"))).toEqual([]);
});


async function renderInRepo(repoDir: string, out = "") {
  return Effect.runPromise(RenderTest.execute(Schema.decodeUnknownSync(RenderWalkthrough.payloadSchema)({
    input: { repo: repoDir, out },
    target: { repoDir, mode: "workspace", ref: "workspace" },
    changes: { files: [{ path: "a.ts", status: "modified", diff: "", reviewed: true }] },
    review, story: null,
  }), { executionId: `render-${crypto.randomUUID()}` }).pipe(Effect.provide(testLayer())));
}

test.each([
  [".smithers-review", ""],
  [".smithers-review/.smithers-review-artifacts", ""],
  ["reports", "reports/walkthrough.html"],
])("render refuses to follow a checked-out %s symlink out of the repository", async (link, out) => {
  const repo = fs.mkdtempSync(join(tmpdir(), "review-symlink-repo-"));
  const victim = fs.mkdtempSync(join(tmpdir(), "review-symlink-victim-"));
  dirs.push(repo, victim);
  fs.mkdirSync(dirname(join(repo, link)), { recursive: true });
  fs.symlinkSync(victim, join(repo, link));
  await expect(renderInRepo(repo, out)).rejects.toMatchObject({
    _tag: "smithers-review/WalkthroughUnwritable",
    message: expect.stringContaining("symbolic link"),
  });
  expect(fs.readdirSync(victim, { recursive: true })).toEqual([]);
});

test("render still writes the default output inside a plain repository", async () => {
  const repo = fs.mkdtempSync(join(tmpdir(), "review-plain-repo-"));
  dirs.push(repo);
  const result = await renderInRepo(repo);
  expect(result.walkthrough.path).toBe(join(repo, ".smithers-review", "walkthrough.html"));
  expect(fs.existsSync(result.walkthrough.path)).toBe(true);
});


test.each(["failed", "completed_with_errors", "completed_with_warnings"] as const)("verifier failure preserves %s status", async (status) => {
  const result = await Effect.runPromise(VerifyTest.execute({
    review: { ...review, status, ok: status !== "failed" }, verdicts: null, failure: "provider refused",
  }, { executionId: `verify-${crypto.randomUUID()}` }).pipe(Effect.provide(testLayer())));
  expect(result.status).toBe(status);
  expect(result.warnings[0]!?.message).toContain("sol: provider refused");
});


function initRepo(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "review-prepare-"));
  dirs.push(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  fs.writeFileSync(join(dir, "app.ts"), "export const v = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  fs.writeFileSync(join(dir, "app.ts"), "export const v = 2;\n");
  return dir;
}

/**
 * A `git` that adds one untracked file to the repository every time the
 * untracked listing is read. Every extra read of the change set therefore sees
 * a working tree the previous read did not.
 */
function mutatingGit(): { dir: string; counter: string } {
  const dir = fs.mkdtempSync(join(tmpdir(), "review-git-shim-"));
  dirs.push(dir);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const counter = join(dir, "reads");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const originalPath = process.env.PATH ?? "";
  fs.writeFileSync(join(dir, "git"), [
    "#!/bin/sh",
    'if [ -n "$REVIEW_MUTATE_REPO" ]; then',
    '  case " $* " in',
    '    *" ls-files "*)',
    '      n=$(cat "$REVIEW_MUTATE_COUNTER" 2>/dev/null || echo 0)',
    "      n=$((n + 1))",
    '      printf %s "$n" > "$REVIEW_MUTATE_COUNTER"',
    `      printf 'export const mutation%s = %s;\\n' "$n" "$n" > "$REVIEW_MUTATE_REPO/mutation-$n.ts"`,
    "      ;;",
    "  esac",
    "fi",
    // A guarded git launcher may resolve the real executable through PATH.
    // Restore its original search path so it cannot select this shim again.
    `export PATH=${quote(originalPath)}`,
    `exec ${quote(realGit)} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { dir, counter };
}

test("preparation derives preview, changes and prompts from one diff snapshot", async () => {
  const repo = initRepo();
  const shim = mutatingGit();
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  process.env.REVIEW_MUTATE_REPO = repo;
  process.env.REVIEW_MUTATE_COUNTER = shim.counter;
  let prepared;
  try {
    prepared = await Effect.runPromise(PrepareTest.execute(
      Schema.decodeUnknownSync(PrepareReview.payloadSchema)({ input: { repo } }),
      { executionId: `prepare-${crypto.randomUUID()}` },
    ).pipe(Effect.provide(testLayer())));
  } finally {
    process.env.PATH = previousPath;
    delete process.env.REVIEW_MUTATE_REPO;
    delete process.env.REVIEW_MUTATE_COUNTER;
  }

  // One read of the change set, so the mutation lands in all three views or none.
  expect(fs.readFileSync(shim.counter, "utf8")).toBe("1");
  const previewPaths = prepared.preview.entries.map((entry) => entry.path).sort();
  expect(previewPaths).toEqual(["app.ts", "mutation-1.ts"]);
  expect(prepared.changes.files.map((file) => file.path).sort()).toEqual(previewPaths);
  expect(prepared.prompt.files.map((file) => file.path).sort()).toEqual(
    prepared.preview.entries.filter((entry) => entry.willReview).map((entry) => entry.path).sort(),
  );
  expect(prepared.changes.totalFiles).toBe(prepared.preview.totalFiles);
});

test("an unexpected renderer defect remains a defect", async () => {
  const failure = new Error("renderer defect");
  const renderHtml = spyOn(renderer, "renderWalkthroughHtml").mockRejectedValue(failure);
  let caught: unknown;
  try { await render(outputPath()); } catch (error) { caught = error; }
  finally { renderHtml.mockRestore(); }
  expect(caught).not.toBeInstanceOf(WalkthroughUnwritable);
  expect((caught as Error).message).toContain("renderer defect");
});
