/**
 * The review flow's model-backed steps.
 *
 * `AgentAction.make` is `Action.make` with a seat, a prompt built from the
 * decoded payload, and an `output` schema the answer must satisfy. The schema
 * is rendered into the run's system teaching and enforced on the way back, with
 * one correction re-prompt, which is what replaces 0.x's per-agent
 * `--output-schema` files and its schema-retry ladder.
 *
 * @since 1.0.0
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import { buildNarratePrompt } from "../walkthrough/buildNarratePrompt.ts";
import { ChangedFile } from "../walkthrough/changedFileSchema.ts";
import { Story } from "../walkthrough/storySchema.ts";
import { arrayOf } from "../schema/withDefault.ts";
import { NativeReviewAgentOutput } from "./nativeReviewAgentOutputSchema.ts";
import { OpenCodeReviewInput } from "./openCodeReviewInputSchema.ts";
import { ReviewComment } from "./reviewCommentSchema.ts";
import { ReviewMode } from "./reviewModeSchema.ts";
import { SEAT } from "./reviewSeats.ts";
import { buildVerifyFindingsPrompt } from "./verifyFindings.ts";
import { VerifyVerdicts } from "./verifyVerdictsSchema.ts";

/**
 * Reviews one file.
 *
 * The prompt is built by `nativeReviewPromptFromSnapshot` in the preparation step and
 * carried here whole, because it embeds the file's diff plus the list of the
 * other changed files. The seat therefore needs no repository access to answer,
 * and the prompt tells it so.
 *
 * @since 1.0.0
 * @category actions
 */
export const ReviewFile = AgentAction.make("smithers-review/ReviewFile", {
  payload: { path: Schema.String, prompt: Schema.String, timeout: OpenCodeReviewInput.fields.timeout },
  output: NativeReviewAgentOutput,
  seat: SEAT.review,
  timeout: ({ timeout }) => Duration.minutes(timeout),
  system: [
    "You are a precise code reviewer. Report only defects you can point at in the diff you were given.",
    "Never invent line numbers, never restate the diff, and never report style preferences as defects.",
  ],
  prompt: ({ prompt }) => prompt,
});

/**
 * Adjudicates the findings a review produced.
 *
 * @since 1.0.0
 * @category actions
 */
export const VerifyFindings = AgentAction.make("smithers-review/VerifyFindings", {
  payload: {
    timeout: OpenCodeReviewInput.fields.timeout,
    findings: arrayOf(ReviewComment),
    files: arrayOf(ChangedFile),
  },
  output: VerifyVerdicts,
  seat: SEAT.verify,
  timeout: ({ timeout }) => Duration.minutes(timeout),
  system: [
    "You adjudicate code-review findings against the diff they were made on.",
    "Keep a finding only when the diff shows the defect. Drop a finding the diff refutes. Demote one whose severity overstates it.",
  ],
  prompt: ({ files, findings }) =>
    buildVerifyFindingsPrompt({
      findings: findings.map((finding) => ({
        path: finding.path,
        content: finding.content,
        severity: finding.severity,
        category: finding.category,
        confidence: finding.confidence,
        startLine: finding.startLine,
        endLine: finding.endLine,
        existingCode: finding.existingCode,
      })),
      filesByPath: new Map(files.map((file) => [file.path, { diff: file.diff }])),
    }),
});

/**
 * Narrates the change set as a story the walkthrough renders.
 *
 * @since 1.0.0
 * @category actions
 */
export const NarrateChanges = AgentAction.make("smithers-review/NarrateChanges", {
  payload: {
    timeout: OpenCodeReviewInput.fields.timeout,
    files: arrayOf(ChangedFile),
    comments: arrayOf(ReviewComment),
    background: Schema.String,
    mode: ReviewMode,
    ref: Schema.String,
  },
  output: Story,
  seat: SEAT.narrate,
  timeout: ({ timeout }) => Duration.minutes(timeout),
  system: [
    "You explain a change set to a reader who has not seen it, in chapters, in the order that makes it easiest to follow.",
  ],
  prompt: ({ background, comments, files, mode, ref }) =>
    buildNarratePrompt({
      files: [...files],
      comments: [...comments],
      background,
      mode: mode === "commit" ? "commit" : mode === "range" ? "range" : "workspace",
      ref,
    }),
});

