#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSession } from "./createSession.ts";
import { fetchOidcToken } from "./fetchOidcToken.ts";
import { gateEvent } from "./gateEvent.ts";
import { materializeInferenceCredentials } from "./materializeInferenceCredentials.ts";
import { resolveInferenceEnv } from "./resolveInferenceEnv.ts";
import { failureDetail, finishedStatus, readSummary, type ReviewSummary } from "./reviewSummary.ts";
import { runReview } from "./runReview.ts";
import { upsertStatusComment } from "./upsertStatusComment.ts";
import { ghBin, runGh } from "../../src/github/runGh.ts";

const QUIZ_MODES = new Set(["off", "auto", "on"]);

/** The action's `quiz` input wins over the server's session default. */
function resolveQuizMode(input: string | undefined, sessionQuiz: unknown): "off" | "auto" | "on" | undefined {
  const explicit = input?.trim().toLowerCase();
  if (explicit && QUIZ_MODES.has(explicit)) return explicit as "off" | "auto" | "on";
  if (explicit) {
    console.log(`::warning::smithers review: ignoring invalid quiz input "${explicit}" (expected off|auto|on)`);
  }
  if (typeof sessionQuiz === "string" && QUIZ_MODES.has(sessionQuiz)) {
    return sessionQuiz as "off" | "auto" | "on";
  }
  return undefined;
}

/** Reviewer-quiz status line, e.g. " — 🧠 reviewer quiz: 4 questions (high impact)". */
function quizNote(summary: ReviewSummary | null): string {
  if (typeof summary?.questions !== "number" || summary.questions <= 0) return "";
  const impact =
    typeof summary.impact === "string" && summary.impact.trim() ? ` (${summary.impact.trim()} impact)` : "";
  return ` — 🧠 reviewer quiz: ${summary.questions} question${summary.questions === 1 ? "" : "s"}${impact}`;
}

/** Quota status line when the session says the quota is spent or nearly so. */
function quotaNote(quota: { remaining?: number; limit?: number; resetsAt?: string } | undefined): string {
  if (typeof quota?.remaining !== "number") return "";
  const reset = typeof quota.resetsAt === "string" && quota.resetsAt.trim() ? `, resets ${quota.resetsAt.trim()}` : "";
  if (quota.remaining <= 0) return ` — ⚠️ monthly review quota is now spent${reset}`;
  const limit = typeof quota.limit === "number" ? quota.limit : undefined;
  const low = quota.remaining <= Math.max(1, Math.ceil((limit ?? 0) * 0.1));
  if (!low) return "";
  const ofLimit = limit ? ` of ${limit}` : "";
  return ` — ⏳ ${quota.remaining}${ofLimit} review${quota.remaining === 1 ? "" : "s"} left this month${reset}`;
}

const NOT_REGISTERED_HINT =
  "open an issue titled `review access: <org>/<repo>` on https://github.com/smithersai/smithers/issues to request access";

/**
 * Composite step entrypoint that runs after the early gate has passed:
 *
 *   1. Re-gate (defence in depth + we still need the parsed decision).
 *   2. For `issue_comment`, resolve the PR and skip fork PRs — the comment
 *      payload has no head-repo info, and checking out a fork tree with
 *      inference credentials in the env would leak secrets.
 *   3. Mint an OIDC token, POST it to /api/sessions. The service refuses a
 *      non-comment trigger on a `comment` mode repo before claiming quota;
 *      the action then skips with a notice and no status comment.
 *   4. Post (or update) the sticky status comment on the PR, and for
 *      `issue_comment` check out the PR head so the CLI sees its tree.
 *   5. Spawn the existing review CLI with proxy env so all inference and the
 *      walkthrough upload go through the session.
 *   6. Update the status comment with the outcome (reviewed / skipped /
 *      failed). Status-comment failures never fail the job.
 */
async function main(): Promise<void> {
  const serviceUrl = process.env.SMITHERS_REVIEW_SERVICE_URL ?? "https://review.jjhub.tech";
  const actionPath = process.env.SMITHERS_ACTION_PATH ?? process.cwd();
  const smithersRoot = resolve(actionPath, "..", "..", "..");
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const runUrl =
    process.env.GITHUB_SERVER_URL && repository && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "";

  if (!eventPath) {
    console.log("::notice::smithers review skipped: GITHUB_EVENT_PATH is empty");
    return;
  }
  const payload = JSON.parse(readFileSync(eventPath, "utf8")) as unknown;

  const decision = gateEvent({ eventName, payload });
  if (!decision.run) {
    console.log(`::notice::smithers review skipped: ${decision.reason}`);
    return;
  }

  const setStatus = async (body: string) => {
    if (!repository) return;
    await upsertStatusComment({ workspace, repository, prNumber: decision.prNumber, body });
  };
  const runLink = runUrl ? ` — [run](${runUrl})` : "";

  if (decision.eventName === "issue_comment") {
    // gateEvent is pure and the issue_comment payload carries no head-repo
    // info, so resolve the PR here: a comment-triggered review of a fork PR
    // would check out the untrusted fork tree with inference credentials in
    // the environment. Fail closed — if gh cannot tell us, do not review.
    let isCrossRepository: boolean;
    try {
      const raw = await runGh(workspace, ["pr", "view", String(decision.prNumber), "--json", "isCrossRepository"]);
      isCrossRepository = (JSON.parse(raw) as { isCrossRepository?: boolean }).isCrossRepository === true;
    } catch (error) {
      await setStatus(`❌ smithers review failed: could not resolve the PR's head repository${runLink}`);
      throw new Error(`could not determine whether PR #${decision.prNumber} is a fork PR: ${(error as Error).message}`);
    }
    if (isCrossRepository) {
      console.log("::notice::smithers review skipped: fork pull requests are not reviewed");
      await setStatus(`⏭️ smithers review skipped: fork pull requests are not reviewed${runLink}`);
      return;
    }
  }

  let oidcToken: string;
  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    oidcToken = await fetchOidcToken();
    session = await createSession({ serviceUrl, oidcToken, pr: decision.prNumber });
  } catch (error) {
    await setStatus(
      `❌ smithers review failed before it could start: ${(error as Error).message.slice(0, 200)}${runLink}`,
    );
    throw error;
  }

  if (session.status === "quota-exhausted") {
    console.log(`::notice::smithers review skipped: this repo's monthly PR quota is spent (${session.message})`);
    await setStatus(`⏭️ smithers review skipped: this repo's monthly PR quota is spent${runLink}`);
    return;
  }
  if (session.status === "repo-spend-exhausted" || session.status === "key-spend-exhausted" ||
      session.status === "payment-required" || session.status === "unavailable") {
    const reason = session.status === "repo-spend-exhausted" ? "repository inference budget exhausted"
      : session.status === "key-spend-exhausted" ? "API key inference budget exhausted"
      : session.status === "unavailable" ? "review service unavailable; retry later"
      : "review service payment required";
    console.log(`::notice::smithers review skipped: ${reason}`);
    await setStatus(`⏭️ smithers review skipped: ${reason}${runLink}`);
    return;
  }
  if (session.status === "not-registered") {
    console.log(
      `::notice::smithers review skipped: this repository is not registered. Open an issue titled "review access: <org>/<repo>" at https://github.com/smithersai/smithers/issues to request access (${session.message})`,
    );
    await setStatus(
      `⏭️ smithers review skipped: this repository is not registered with the review service — ${NOT_REGISTERED_HINT}`,
    );
    return;
  }
  if (session.status === "error") {
    await setStatus(`❌ smithers review failed: could not create a review session${runLink}`);
    throw new Error(`/api/sessions failed: ${session.message}`);
  }

  // `session.mode` covers a service deployed before it refused with 409.
  if (session.status === "comment-mode" || (decision.eventName === "pull_request" && session.mode === "comment")) {
    console.log(
      `::notice::smithers review skipped: this repo is in comment mode — comment "@smithers review" on the PR to trigger a review.`,
    );
    return;
  }

  await setStatus(`🔍 smithers review started${runLink}`);

  if (decision.eventName === "issue_comment") {
    // ghBin(), not a literal: every other GitHub call in this action honors
    // SMITHERS_GH_BIN, and a checkout that spawns a different binary than the
    // fork check would either crash or check out under another credential.
    execFileSync(ghBin(), ["pr", "checkout", String(decision.prNumber)], {
      cwd: workspace,
      stdio: "inherit",
      env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN ?? "" },
    });
  }

  const inference = resolveInferenceEnv({
    anthropicBaseUrl: session.anthropicBaseUrl,
    sessionToken: session.token,
  });
  // Scrub every raw caller-supplied credential before spawning the review CLI:
  // the run reads an untrusted diff, and `inference.env` re-supplies exactly
  // what it needs. See materializeInferenceCredentials.
  materializeInferenceCredentials({ env: process.env });

  const summaryPath = join(process.env.RUNNER_TEMP?.trim() || tmpdir(), `smithers-review-summary-${process.pid}.json`);
  const exitCode = await runReview({
    smithersRoot,
    workspace,
    prNumber: decision.prNumber,
    inferenceEnv: inference.env,
    publishUrl: session.publishUrl,
    publishToken: session.token,
    ghToken: process.env.GH_TOKEN,
    quiz: resolveQuizMode(process.env.SMITHERS_REVIEW_QUIZ, session.quiz),
    concurrency: inference.concurrency,
    summaryPath,
  });

  const summary = readSummary(summaryPath);
  if (exitCode === 0) {
    const outcome = summary ? finishedStatus(summary) : `✅ smithers review finished${runLink}`;
    await setStatus(`${outcome}${quizNote(summary)}${quotaNote(session.quota)}`);
  } else {
    await setStatus(`❌ smithers review failed${failureDetail(summary, exitCode)}${runLink}`);
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error(`smithers review action: ${(error as Error).message ?? String(error)}`);
  process.exit(1);
});
