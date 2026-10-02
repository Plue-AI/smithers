import * as Schema from "effect/Schema";
import { NativeReviewPrompt } from "../workflow/nativeReviewPromptSchema.ts";
import { NativeReviewAgentOutput } from "../workflow/nativeReviewAgentOutputSchema.ts";
import { ReviewSummary } from "../workflow/reviewSummarySchema.ts";
import { ReviewRunOutput } from "../workflow/reviewRunOutputSchema.ts";
import { normalizeOpenCodeReviewInput } from "../workflow/normalizeOpenCodeReviewInput.ts";
import { anchorFinding } from "./anchorFinding.ts";
import { dedupeFindings } from "./dedupeFindings.ts";
import { rankSeverity } from "./rankSeverity.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";
import type { PreviewOutput } from "../workflow/previewOutputSchema.ts";
import type { ReviewComment } from "../workflow/reviewCommentSchema.ts";
import type { ReviewWarning } from "../workflow/reviewWarningSchema.ts";
import type { NativeReviewFileResult } from "./nativeReviewFileResult.ts";

const decodePrompt = Schema.decodeUnknownSync(NativeReviewPrompt);
const decodeAgentOutput = Schema.decodeUnknownSync(NativeReviewAgentOutput);
const decodeSummary = Schema.decodeUnknownSync(ReviewSummary);
const decodeRunOutput = Schema.decodeUnknownSync(ReviewRunOutput);

function skippedReviewOutput(prepared: NativeReviewPrompt): ReviewRunOutput {
  return decodeRunOutput({
    status: "skipped",
    ok: true,
    reviewer: "smithers-native",
    message: prepared.message || "Review skipped.",
    summary: null,
    comments: [],
    warnings: prepared.warnings,
    error: "",
  });
}
function sortComments(comments: Array<ReviewComment>) {
  return [...comments].sort((a, b) => {
    const bySeverity = rankSeverity(a.severity) - rankSeverity(b.severity);
    if (bySeverity !== 0) return bySeverity;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.startLine - b.startLine;
  });
}

function normalizedComment(comment: ReviewComment, path: string) {
  const startLine = Math.max(0, comment.startLine || 0);
  const endLine = Math.max(startLine, comment.endLine || startLine);
  return {
    ...comment,
    path,
    content: comment.content.trim(),
    suggestionCode: comment.suggestionCode.trim(),
    existingCode: comment.existingCode.trim(),
    thinking: comment.thinking.trim(),
    startLine,
    endLine,
  };
}

/**
 * Folds every file's answer into one review result.
 *
 * This is where a seat's output stops being trusted: findings are scoped to
 * the file that was reviewed, anchored to lines the diff actually contains,
 * de-duplicated, and counted. A file whose review failed becomes a
 * `subtask_error` warning; the run fails only when every file review fails.
 * Incomplete statuses preserve their messages as file-scoped warnings.
 * Results must explicitly pair each output with its reviewed file.
 *
 * @since 1.0.0
 * @category constructors
 */
export function finalizeNativeReview(
  input: OpenCodeReviewInput,
  prepared: NativeReviewPrompt,
  preview: PreviewOutput,
  fileResults: ReadonlyArray<NativeReviewFileResult>,
): ReviewRunOutput {
  input = normalizeOpenCodeReviewInput(input);
  prepared = decodePrompt(prepared);
  if (!prepared.shouldReview || !input.runReview) return skippedReviewOutput(prepared);

  const byFileId = new Map(fileResults.map((result) => [result.file.id, result]));
  const orderedResults = prepared.files.map((file) => byFileId.get(file.id) ?? { file, output: null });

  const reviewablePaths = new Set(preview.entries.filter((entry) => entry.willReview).map((entry) => entry.path));
  const warnings: Array<ReviewWarning> = [...prepared.warnings];
  const comments: Array<ReviewComment> = [];
  let failedFiles = 0;

  for (const result of orderedResults) {
    if (!result.output) {
      failedFiles += 1;
      warnings.push({
        file: result.file.path,
        type: "subtask_error",
        message: "Native Smithers file review did not produce output.",
      });
      continue;
    }
    const parsed = decodeAgentOutput(result.output);
    switch (parsed.status) {
      case "success":
        break;
      case "failed":
        failedFiles += 1;
        warnings.push({
          file: result.file.path,
          type: "subtask_error",
          message: parsed.message.trim() || "Native Smithers file review failed.",
        });
        break;
      case "completed_with_errors":
      case "completed_with_warnings":
        warnings.push({
          file: result.file.path,
          type: parsed.status === "completed_with_errors" ? "subtask_error" : "subtask_warning",
          message: parsed.message.trim() || `Native Smithers file review ${parsed.status.replaceAll("_", " ")}.`,
        });
        break;
      default:
        parsed.status satisfies never;
    }
    warnings.push(...parsed.warnings);
    for (const comment of parsed.comments) {
      const path = comment.path.trim();
      if (path && path !== result.file.path) {
        warnings.push({
          file: result.file.path,
          type: "out_of_scope_comment",
          message: `Dropped comment targeting ${path} from review of ${result.file.path}.`,
        });
        continue;
      }
      comments.push(anchorFinding(normalizedComment(comment, result.file.path), result.file.diff));
    }
  }

  const scopedComments = comments.filter((comment) => comment.content && reviewablePaths.has(comment.path));
  const droppedComments = comments.length - scopedComments.length;
  if (droppedComments > 0) {
    warnings.push({
      file: "",
      type: "out_of_scope_comment",
      message: `Dropped ${droppedComments} comment(s) outside the reviewable file set.`,
    });
  }

  const deduped = dedupeFindings(scopedComments);
  if (deduped.dropped > 0) {
    warnings.push({
      file: "",
      type: "duplicate_comment",
      message: `Dropped ${deduped.dropped} duplicate comment(s); kept the highest-severity copy.`,
    });
  }
  const finalComments = sortComments(deduped.comments);

  // Agents fabricate token counts in their structured output; leave usage unknown rather
  // than presenting fiction as telemetry in a metered product.
  const summary = decodeSummary({
    filesReviewed: prepared.reviewableFiles,
    comments: finalComments.length,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    elapsed: "",
  });
  const status =
    failedFiles >= prepared.files.length
      ? "failed"
      : warnings.length > 0
        ? "completed_with_warnings"
        : "success";

  return decodeRunOutput({
    status,
    ok: status !== "failed",
    reviewer: "smithers-native",
    message:
      status === "failed"
        ? `All ${prepared.files.length} file review(s) failed.`
        : finalComments.length > 0
          ? `Reviewed ${prepared.reviewableFiles} file(s) and produced ${finalComments.length} comment(s).`
          : status === "completed_with_warnings"
            ? "No comments generated. Review completed with warnings; see diagnostics."
            : "No comments generated. Looks good to me.",
    summary,
    comments: finalComments,
    warnings,
    error: status === "failed" ? "Native Smithers review failed." : "",
  });
}
