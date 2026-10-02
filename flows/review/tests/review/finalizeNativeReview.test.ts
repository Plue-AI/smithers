import { describe, expect, test } from "bun:test";
import { finalizeNativeReview } from "../../src/review/finalizeNativeReview.ts";
import type { NativeReviewAgentOutput } from "../../src/workflow/nativeReviewAgentOutputSchema.ts";
import type { NativeReviewPrompt } from "../../src/workflow/nativeReviewPromptSchema.ts";
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts";
import type { PreviewOutput } from "../../src/workflow/previewOutputSchema.ts";

describe("finalizeNativeReview", () => {
  const diffText = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " const keep = 1;",
    "-const removed = 2;",
    "+const added = 2;",
    "+const more = 3;",
    " const tail = 4;",
  ].join("\n");

  function prepared(files: Array<{ id: string; path: string; diff: string }>): NativeReviewPrompt {
    return {
      shouldReview: true,
      repoDir: "/repo",
      mode: "workspace",
      ref: "workspace",
      reviewableFiles: files.length,
      excludedFiles: 0,
      files: files.map((f) => ({
        id: f.id,
        path: f.path,
        status: "modified",
        insertions: 2,
        deletions: 1,
        diff: f.diff,
        prompt: "",
      })),
      message: "prepared",
      warnings: [],
    };
  }

  function preview(paths: string[]): PreviewOutput {
    return {
      entries: paths.map((path) => ({
        path,
        status: "modified",
        insertions: 2,
        deletions: 1,
        willReview: true,
        excludeReason: "",
      })),
      totalInsertions: 2 * paths.length,
      totalDeletions: paths.length,
      totalFiles: paths.length,
      reviewableCount: paths.length,
      excludedCount: 0,
    };
  }

  const baseInput = normalizeOpenCodeReviewInput({});

  const emptyOutput: NativeReviewAgentOutput = {
    status: "success",
    message: "",
    summary: null,
    warnings: [],
    comments: [],
  };
  const finding = {
    path: "",
    content: "Unsafe call needs a guard",
    suggestionCode: "safeA();",
    existingCode: "unsafeA();",
    startLine: 0,
    endLine: 0,
    thinking: "",
    severity: "major" as const,
    category: "correctness" as const,
    confidence: "confirmed" as const,
  };

  test("rejects a finding naming another reviewable file before anchoring", () => {
    const p = prepared([
      { id: "a", path: "src/a.ts", diff: "@@ -0,0 +1 @@\n+unsafeA();" },
      { id: "b", path: "src/b.ts", diff: "@@ -0,0 +1 @@\n+safeB();" },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts", "src/b.ts"]), [
      { file: p.files[1]!, output: emptyOutput },
      {
        file: p.files[0]!,
        output: { ...emptyOutput, comments: [{ ...finding, path: " src/b.ts " }, finding] },
      },
    ]);
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0]!).toMatchObject({
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      suggestionCode: "safeA();",
    });
    expect(out.warnings).toContainEqual({
      file: "src/a.ts",
      type: "out_of_scope_comment",
      message: "Dropped comment targeting src/b.ts from review of src/a.ts.",
    });
  });

  for (const status of ["success", "completed_with_warnings", "completed_with_errors", "failed"] as const) {
    for (const hasWarnings of [false, true]) {
      test(`preserves ${status} with ${hasWarnings ? "populated" : "empty"} warnings`, () => {
        const p = prepared([{ id: "a", path: "src/a.ts", diff: diffText }]);
        const warnings = hasWarnings ? [{ file: "src/a.ts", type: "note", message: "agent note" }] : [];
        const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
          {
            file: p.files[0]!,
            output: { ...emptyOutput, status, message: `seat: ${status}`, warnings },
          },
        ]);
        expect(out.status).toBe(
          status === "failed"
            ? "failed"
            : status !== "success" || hasWarnings
              ? "completed_with_warnings"
              : "success",
        );
        expect(out.ok).toBe(status !== "failed");
        for (const warning of warnings) expect(out.warnings).toContainEqual(warning);
        if (status !== "success") {
          expect(out.warnings).toContainEqual({
            file: "src/a.ts",
            type: status === "completed_with_warnings" ? "subtask_warning" : "subtask_error",
            message: `seat: ${status}`,
          });
          expect(out.message).not.toContain("Looks good to me");
        }
      });
    }
  }

  for (const status of ["completed_with_warnings", "completed_with_errors"] as const) {
    test(`supplies a diagnostic when ${status} has no message`, () => {
      const p = prepared([{ id: "a", path: "src/a.ts", diff: diffText }]);
      const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
        {
          file: p.files[0]!,
          output: { ...emptyOutput, status, message: "  " },
        },
      ]);
      expect(out.status).toBe("completed_with_warnings");
      expect(out.warnings).toContainEqual({
        file: "src/a.ts",
        type: status === "completed_with_warnings" ? "subtask_warning" : "subtask_error",
        message: `Native Smithers file review ${status.replaceAll("_", " ")}.`,
      });
    });
  }

  test("counts added prefix increments before anchoring following code", () => {
    const p = prepared([
      {
        id: "a",
        path: "src/a.ts",
        diff: "--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+++counter;\n+unsafeA();",
      },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      {
        file: p.files[0]!,
        output: { ...emptyOutput, comments: [finding] },
      },
    ]);
    expect(out.comments[0]!).toMatchObject({ startLine: 2, endLine: 2 });
  });

  test("does not anchor removed SQL comments through adjacent context", () => {
    const p = prepared([
      {
        id: "a",
        path: "src/a.ts",
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1 @@\n--- comment\n unsafeA();",
      },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      {
        file: p.files[0]!,
        output: { ...emptyOutput, comments: [{ ...finding, existingCode: "-- comment\nunsafeA();" }] },
      },
    ]);
    expect(out.comments[0]!).toMatchObject({ startLine: 0, endLine: 0 });
  });

  test("returns skipped when the prompt says not to review", () => {
    const out = finalizeNativeReview(
      baseInput,
      { ...prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]), shouldReview: false, message: "nope" },
      preview(["src/a.ts"]),
      [],
    );
    expect(out.status).toBe("skipped");
    expect(out.ok).toBe(true);
    expect(out.message).toBe("nope");
  });

  test("anchors, dedupes, drops out-of-scope, and reports warnings", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      {
        file: p.files[0]!,
        output: {
          status: "completed_with_warnings",
          message: "",
          summary: null,
          warnings: [{ file: "src/a.ts", message: "agent note", type: "note" }],
          comments: [
            // explicit line, within the new-side range → kept as-is
            {
              path: "",
              content: "Added constant is unused",
              suggestionCode: "",
              existingCode: "",
              startLine: 2,
              endLine: 3,
              thinking: "  reasoned  ",
              severity: "major",
              category: "correctness",
              confidence: "confirmed",
            },
            // resolved from existingCode on the new side
            {
              path: "src/a.ts",
              content: "another finding via existingCode",
              suggestionCode: "const added = safe();",
              existingCode: "const more = 3;",
              startLine: 0,
              endLine: 0,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
            // near-duplicate of the first (overlapping lines, near-identical text) → deduped
            {
              path: "src/a.ts",
              content: "Added constant is unused!!",
              suggestionCode: "",
              existingCode: "",
              startLine: 2,
              endLine: 2,
              thinking: "",
              severity: "critical",
              category: "correctness",
              confidence: "confirmed",
            },
            // out-of-scope path → dropped
            {
              path: "elsewhere/x.ts",
              content: "not in scope",
              suggestionCode: "",
              existingCode: "",
              startLine: 1,
              endLine: 1,
              thinking: "",
              severity: "info",
              category: "other",
              confidence: "plausible",
            },
          ],
        },
      },
    ]);
    expect(out.status).toBe("completed_with_warnings");
    expect(out.comments.length).toBeGreaterThan(0);
    // The near-duplicate kept the highest severity (critical) copy.
    expect(out.comments.some((c) => c.severity === "critical")).toBe(true);
    // Warnings mention the out-of-scope drop and the duplicate drop.
    expect(out.warnings.some((w) => w.type === "out_of_scope_comment")).toBe(true);
    expect(out.warnings.some((w) => w.type === "duplicate_comment")).toBe(true);
    // The existingCode-resolved comment anchored to a real new-side line.
    const resolved = out.comments.find((c) => c.content.includes("existingCode"));
    expect(resolved?.startLine).toBeGreaterThan(0);
  });

  test("zeroes deleted-line existingCode and anchors that cannot resolve", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      {
        file: p.files[0]!,
        output: {
          status: "success",
          message: "",
          summary: null,
          warnings: [],
          comments: [
            // existingCode matches only a deleted line → remains unanchored
            {
              path: "src/a.ts",
              content: "removed line concern",
              suggestionCode: "",
              existingCode: "const removed = 2;",
              startLine: 0,
              endLine: 0,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
            // agent-supplied line outside the diff and no resolvable existingCode → zeroed
            {
              path: "src/a.ts",
              content: "bogus line",
              suggestionCode: "",
              existingCode: "does not appear anywhere",
              startLine: 999,
              endLine: 999,
              thinking: "",
              severity: "info",
              category: "other",
              confidence: "plausible",
            },
          ],
        },
      },
    ]);
    const zeroed = out.comments.find((c) => c.content === "bogus line");
    expect(zeroed?.startLine).toBe(0);
    expect(zeroed?.endLine).toBe(0);
    const deleted = out.comments.find((c) => c.content === "removed line concern");
    expect(deleted?.startLine).toBe(0);
    expect(deleted?.endLine).toBe(0);
  });

  test("an explicitly paired output completes its prepared file", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      { file: p.files[0]!, output: { ...emptyOutput, message: "ok" } },
    ]);
    // No comments, no warnings → success.
    expect(out.status).toBe("success");
    expect(out.message).toContain("No comments generated");
  });

  test("an explicitly null file output fails the run", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      { file: p.files[0]!, output: null },
    ]);
    expect(out.status).toBe("failed");
    expect(out.warnings[0]!.file).toBe("src/a.ts");
  });

  test("a missing per-file output is a subtask_error and, if total, fails the run", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    // No outputs → the one file has no output → failedFiles == files.length → failed.
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), []);
    expect(out.status).toBe("failed");
    expect(out.ok).toBe(false);
    expect(out.warnings.some((w) => w.type === "subtask_error")).toBe(true);
    expect(out.error).toContain("failed");
  });

  test("an explicit failed status on a single file fails the run", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      { file: p.files[0]!, output: { ...emptyOutput, status: "failed", message: "agent exploded" } },
    ]);
    expect(out.status).toBe("failed");
    expect(out.warnings.some((w) => w.message.includes("agent exploded"))).toBe(true);
  });

  test("near-identical (not identical) comments dedupe via edit-distance; equal-severity comments sort by path then line", () => {
    const p = prepared([
      { id: "f1", path: "src/a.ts", diff: diffText },
      { id: "f2", path: "src/b.ts", diff: diffText },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts", "src/b.ts"]), [
      {
        file: p.files[0]!,
        output: {
          status: "success",
          message: "",
          summary: null,
          warnings: [],
          comments: [
            // two same-severity findings on distinct paths → sort compares paths
            {
              path: "src/a.ts",
              content: "The value here is off by one",
              suggestionCode: "",
              existingCode: "",
              startLine: 3,
              endLine: 3,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
            // near-identical to the first, overlapping line (3), one char different →
            // edit-distance similarity ≥ 0.9 → deduped.
            {
              path: "src/a.ts",
              content: "The value here is off by ane",
              suggestionCode: "",
              existingCode: "",
              startLine: 3,
              endLine: 3,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
            // same path + severity, different line, distinct content → kept, sorts by startLine
            {
              path: "src/a.ts",
              content: "A totally separate concern about tail",
              suggestionCode: "",
              existingCode: "",
              startLine: 2,
              endLine: 2,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
          ],
        },
      },
      {
        file: p.files[1]!,
        output: {
          status: "success",
          message: "",
          summary: null,
          warnings: [],
          comments: [
            {
              path: "src/b.ts",
              content: "b file concern unrelated entirely",
              suggestionCode: "",
              existingCode: "",
              startLine: 3,
              endLine: 3,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
          ],
        },
      },
    ]);
    // The near-duplicate was dropped (3 in → 3 kept: a@2, a@3, b@3).
    expect(out.warnings.some((w) => w.type === "duplicate_comment")).toBe(true);
    const aComments = out.comments.filter((c) => c.path === "src/a.ts");
    expect(aComments).toHaveLength(2);
    // Same severity, same path → sorted ascending by startLine.
    expect(aComments[0]!.startLine).toBeLessThan(aComments[1]!.startLine);
    // src/a.ts sorts before src/b.ts at equal severity.
    expect(out.comments[0]!.path).toBe("src/a.ts");
    expect(out.comments.at(-1)?.path).toBe("src/b.ts");
  });

  test("a missing file result preserves completed files and warns", () => {
    const p = prepared([
      { id: "f1", path: "src/a.ts", diff: diffText },
      { id: "f2", path: "src/b.ts", diff: diffText },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts", "src/b.ts"]), [
      { file: p.files[1]!, output: emptyOutput },
    ]);
    expect(out.status).toBe("completed_with_warnings");
    expect(out.warnings).toEqual([
      {
        file: "src/a.ts",
        type: "subtask_error",
        message: "Native Smithers file review did not produce output.",
      },
    ]);
  });
});
