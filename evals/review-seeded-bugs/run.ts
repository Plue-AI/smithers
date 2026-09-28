/**
 * Runs the seeded-bug suite and gates it on the committed baseline.
 *
 * Launch line, from the repository root:
 *
 * ```bash
 * node evals/review-seeded-bugs/run.ts
 * ```
 *
 * The default run is offline and deterministic: every fixture is materialized
 * as a real git repository, the real review flow runs over its real diff, and
 * the reviewing seat is `deterministicReviewer.ts` rather than a model. The
 * committed `baseline.json` is that run's per-fixture score, including where
 * each planted bug was anchored and how it was graded, so a red gate
 * means the PIPELINE moved — diff ingestion, fan-out, scoping, anchoring,
 * de-duplication, or the scorer — not that a model had a bad day.
 *
 * `--live` runs the same suite against real seats instead, prints the
 * scorecard, and writes a timestamped report under `.report/`. It spends real
 * inference budget and its numbers belong in `SCORECARD.md`, never in the
 * baseline.
 *
 * `--update` rewrites `baseline.json` from an offline run. Do that only when a
 * score moved for a reason you can name.
 *
 * Exit codes: `0` every fixture matched the baseline, `1` the run disagrees
 * with it, `2` the harness could not decide.
 *
 * @since 1.0.0
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Review } from "../../apps/review/src/workflow/reviewFlow.ts";
import { layerMemory } from "../../apps/review/src/workflow/reviewLayer.ts";
import { reviewSeatResolver } from "../../apps/review/src/workflow/reviewSeatResolver.ts";
import { resolveReviewSeats } from "../../apps/review/src/workflow/reviewSeats.ts";
import { type Baseline, baselineFrom, drift, type FixtureOutcome } from "./baseline.ts";
import { answerReview } from "./deterministicReviewer.ts";
import { materializeFixture } from "./fixtureRepo.ts";
import { loadCorpus, type PlantedBugLabel } from "./labels.ts";
import { scriptedSeats } from "./scriptedSeats.ts";
import { scoreCorpus, type CorpusScore, type ReviewFinding } from "./score.ts";

const corpusDir = join(import.meta.dirname, "corpus");
const baselinePath = join(import.meta.dirname, "baseline.json");

interface FixtureRun extends FixtureOutcome {
  findings: ReviewFinding[];
}

async function runFixture(label: PlantedBugLabel, layer: ReturnType<typeof layerMemory>): Promise<FixtureRun> {
  const workRoot = mkdtempSync(join(tmpdir(), `review-seeded-${label.fixture}-`));
  try {
    const repoDir = materializeFixture(join(corpusDir, label.fixture), workRoot);
    const result = await Effect.runPromise(
      Review.execute(
        {
          repo: repoDir,
          runReview: true,
          narrate: false,
          quiz: "off",
          // Verification is off so the score measures the reviewer, not a
          // second seat's willingness to drop its findings.
          verify: false,
          out: join(workRoot, "walkthrough.html"),
        } as never,
        { executionId: `review-seeded-${label.fixture}-${Date.now()}` },
      ).pipe(Effect.provide(layer), Effect.orDie),
    );
    return {
      fixture: label.fixture,
      status: result.review.status,
      findings: result.review.comments.map((comment) => ({
        path: comment.path,
        startLine: comment.startLine,
        endLine: comment.endLine,
        severity: comment.severity,
        content: comment.content,
        category: comment.category,
        confidence: comment.confidence,
      })),
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
}

function percent(value: number | null): string {
  return value == null ? "n/a" : `${Math.round(value * 1000) / 10}%`;
}

function numberOrNa(value: number | null): string {
  return value == null ? "n/a" : String(Math.round(value * 1000) / 1000);
}

function labelKind(label: PlantedBugLabel): string {
  return label.clean ? "clean" : label.bugClass;
}

function renderScorecard(labels: readonly PlantedBugLabel[], score: CorpusScore, generatedAt: string): string {
  const labelsByFixture = new Map(labels.map((label) => [label.fixture, label]));
  const lines = [
    "# Review Seeded-Bug Scorecard",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Overall",
    "",
    `- Recall: ${percent(score.recall)} (${score.counts.truePositives}/${score.counts.plantedBugs})`,
    `- Precision: ${percent(score.precision)} (${score.counts.truePositives}/${
      score.counts.truePositives + score.counts.falsePositives
    })`,
    `- F1: ${percent(score.f1)}`,
    `- Mean anchor offset: ${numberOrNa(score.anchorAccuracy.meanLineOffset)} lines`,
    `- Mean absolute anchor offset: ${numberOrNa(score.anchorAccuracy.meanAbsoluteLineOffset)} lines`,
    `- Tight-anchor rate: ${percent(score.anchorAccuracy.fractionWithinTightTolerance)}`,
    `- Severity exact-match rate: ${percent(score.severityCalibration.exactSeverityMatchRate)}`,
    `- Mean severity ordinal error: ${numberOrNa(score.severityCalibration.meanAbsoluteOrdinalError)}`,
    "",
    "## Fixtures",
    "",
    "| Fixture | Label | Findings | TP | FP | FN |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const fixture of score.fixtures) {
    const label = labelsByFixture.get(fixture.fixture);
    lines.push(
      `| ${fixture.fixture} | ${label ? labelKind(label) : "unknown"} | ${fixture.findings} | ${fixture.matches} | ${fixture.falsePositives} | ${fixture.falseNegatives} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Runs the suite. Returns the process exit code.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const live = argv.includes("--live");
  const update = argv.includes("--update");
  // Compose before any fixture directory or Git process exists.
  const seats = live ? reviewSeatResolver(resolveReviewSeats()) : scriptedSeats(answerReview);
  const layer = live ? layerMemory(seats) : layerMemory(seats, {});
  const labels = loadCorpus();

  const runs: FixtureRun[] = [];
  const findingsByFixture: Record<string, ReviewFinding[]> = {};
  for (const label of labels) {
    const fixtureRun = await runFixture(label, layer);
    runs.push(fixtureRun);
    findingsByFixture[label.fixture] = fixtureRun.findings;
  }
  const score = scoreCorpus(labels, findingsByFixture);
  const generatedAt = new Date().toISOString();
  const scorecard = renderScorecard(labels, score, generatedAt);

  if (live) {
    const stamp = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
    const reportDir = join(import.meta.dirname, ".report", stamp);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, "report.json"),
      JSON.stringify({ generatedAt, labels, runs, findingsByFixture, score }, null, 2),
    );
    writeFileSync(join(reportDir, "SCORECARD.md"), scorecard);
    process.stdout.write(`${scorecard}\nreport: ${reportDir}\n`);
    return 0;
  }

  const current = baselineFrom(labels, runs, score);
  if (update) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    process.stdout.write(`${scorecard}\nrecorded ${current.records.length} baseline record(s)\n`);
    return 0;
  }

  let baseline: Baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  } catch (error) {
    process.stderr.write(`could not read ${baselinePath}: ${(error as Error).message}\n`);
    return 2;
  }
  const disagreements = drift(baseline, current);
  process.stdout.write(scorecard);
  if (disagreements.length === 0) {
    process.stdout.write(`\nreview-seeded-bugs: ${current.records.length} fixture(s) match the baseline\n`);
    return 0;
  }
  process.stdout.write(`\n${disagreements.map((line) => `  ${line}`).join("\n")}\n`);
  process.stdout.write(
    `\nreview-seeded-bugs: ${disagreements.length} disagreement(s) with ${baselinePath}\n` +
      "re-record with `node evals/review-seeded-bugs/run.ts --update` only when the change is intended\n",
  );
  return 1;
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  process.exitCode = await main();
}
