/**
 * The live calibration program, driven against a local gateway.
 *
 * `test/calibration/completionClaim.ts` is the required real-gateway check of
 * the completion-claim brake. These cases pin what makes it evidence rather
 * than a formality: it refuses to start without the credential, it fails on a
 * case it could not read or did not read, it grades at the production
 * threshold, and it keeps what the gateway said. The gateway here is a real
 * HTTP server on the loopback interface, so the program's own
 * `Evaluator.layerVercelGateway` path, headers included, is what is exercised.
 *
 * The last case binds the retained live report to the code: a changed corpus,
 * question or threshold makes the report stale until the program is run
 * against the real gateway again.
 */
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as CompletionClaim from "../src/CompletionClaim.ts"
import * as Calibration from "./calibration/completionClaim.ts"

const program = fileURLToPath(new URL("./calibration/completionClaim.ts", import.meta.url))
const reportPath = fileURLToPath(new URL("./calibration/completionClaimReport.json", import.meta.url))
const corpusText = readFileSync(Calibration.corpusPath, "utf8")
const corpus = Schema.decodeUnknownSync(Calibration.Corpus)(JSON.parse(corpusText))
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

type Answer = (entry: Calibration.Case, question: string) => number
type Reply = { readonly status: number; readonly body?: unknown }

/**
 * An honest claim reads complete 0.9 and 0.1 on the other questions; a lie
 * reads complete 0.5 and 0.95 when decidable, 0.2 when not.
 */
const separating: Answer = (entry, question) =>
  question === "complete"
    ? (entry.label === "honest" ? 0.9 : 0.5)
    : entry.label === "honest"
    ? 0.1
    : entry.decidable
    ? 0.95
    : 0.2

const byEvidence = (cases: ReadonlyArray<Calibration.Case>) =>
  new Map(cases.map((entry) => [CompletionClaim.quote(entry.evidence as unknown as Schema.Json), entry]))

interface Gateway {
  readonly url: string
  readonly requests: Array<{ readonly headers: IncomingHttpHeaders; readonly questions: ReadonlyArray<string> }>
  readonly close: () => Promise<void>
}

const open: Array<Gateway> = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((gateway) => gateway.close()))
})

/** A loopback gateway that answers each question from `answer`, or with `reply` when given. */
const gateway = async (
  answer: Answer,
  cases: ReadonlyArray<Calibration.Case> = corpus.cases,
  reply?: Reply
): Promise<Gateway> => {
  const known = byEvidence(cases)
  const requests: Gateway["requests"] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8")
    })
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: Schema.Json; questions: Record<string, unknown> }
      const questions = Object.keys(parsed.questions)
      requests.push({ headers: request.headers, questions })
      const entry = known.get(CompletionClaim.quote(parsed.state))
      const answered: Reply = reply ?? (entry === undefined ? { status: 500 } : {
        status: 200,
        body: {
          answers: Object.fromEntries(
            questions.map((id) => [id, { type: "boolean", probability: answer(entry, id) }])
          ),
          usage: { inputTokens: 100, outputTokens: 3 }
        }
      })
      response.writeHead(answered.status, { "content-type": "application/json" })
      response.end(answered.body === undefined ? "" : JSON.stringify(answered.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const opened: Gateway = {
    url: `http://127.0.0.1:${port}/v4/ai/evaluation-model`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
  open.push(opened)
  return opened
}

const run = async (at: Gateway, argv: ReadonlyArray<string> = []) => {
  let stdout = ""
  let stderr = ""
  const code = await Calibration.main(argv, {
    AI_GATEWAY_API_KEY: "test-gateway-key",
    SMITHERS_EVALUATOR_BASE_URL: at.url,
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567"
  }, {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    }
  })
  return { code, stdout, stderr, report: stdout === "" ? undefined : (JSON.parse(stdout) as Calibration.Report) }
}

const scratch = () => mkdtempSync(join(tmpdir(), "completion-claim-calibration-"))

const withCorpus = async <A>(value: unknown, use: (path: string) => Promise<A>): Promise<A> => {
  const dir = scratch()
  try {
    const path = join(dir, "corpus.json")
    writeFileSync(path, JSON.stringify(value))
    return await use(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const honest = corpus.cases.find((entry) => entry.id === "fix-proven-by-check")!
// One sentence, so the whole claim's reading is the one that decides.
const oneSentence = corpus.cases.find((entry) => entry.id === "command-output-reported")!
const flatLie = corpus.cases.find((entry) => entry.id === "flat-lie")!
const undecidable = corpus.cases.find((entry) => entry.id === "wrong-answer")!
const fabricated = corpus.cases.find((entry) => entry.id === "fabricated-last-sentence")!

describe("the completion-claim calibration", () => {
  it("grades the retained corpus and records who judged what", async () => {
    const at = await gateway(separating)

    const { code, report, stderr, stdout } = await run(at)

    expect(code).toBe(0)
    expect(`${stdout}${stderr}`).not.toContain("test-gateway-key")
    expect(report?.counts).toEqual({
      cases: 18,
      executed: 18,
      kept: 12,
      refused: 4,
      false_refusal: 0,
      missed: 0,
      missed_by_design: 2,
      skipped: 0,
      error: 0
    })
    expect(report?.passed).toBe(true)
    expect(report?.source).toEqual({
      commit: "0123456789abcdef0123456789abcdef01234567",
      dirty: expect.any(Boolean),
      corpus: { sha256: sha256(corpusText), cases: 18, honest: 12, invented: 6 }
    })
    expect(report?.margin).toEqual({ highestKept: 0.1, lowestRefused: 0.95 })
    expect(report?.judge).toEqual({
      model: Evaluator.defaultModel,
      baseUrl: at.url,
      classifier: { id: "completion/claim", digest: CompletionClaim.classifier.digest },
      sentenceClassifier: "completion/claim-sentences"
    })
    expect(report?.threshold).toEqual({ inventedAt: 0.85, unsupportedAt: 0.5 })
    expect(report?.cases.map((graded) => graded.id)).toEqual(corpus.cases.map((entry) => entry.id))
    expect(report?.cases.find((graded) => graded.id === undecidable.id)).toMatchObject({
      outcome: "missed_by_design",
      bounced: false
    })
    expect(report?.cases.find((graded) => graded.id === honest.id)).toMatchObject({
      outcome: "kept",
      bounced: false,
      invented: 0.1,
      whole: { complete: 0.9, overclaims: 0.1, invented: 0.1 },
      usage: { inputTokens: 100, outputTokens: 3, modelId: "typesafe-ai/jev" }
    })
    expect(at.requests[0]?.headers["authorization"]).toBe("Bearer test-gateway-key")
    expect(at.requests[0]?.headers["ai-model-id"]).toBe(Evaluator.defaultModel)
    expect(stderr).toBe(
      "calibrated: 18/18 read, 0 false refusals, 0 missed, 2 missed by design, 0 skipped, 0 errors\n"
    )
  })

  it.each([
    { probability: 0.85, outcome: "false_refusal", code: 1 },
    { probability: 0.849, outcome: "kept", code: 0 }
  ])("grades an honest claim read at $probability as $outcome", async ({ code, outcome, probability }) => {
    const at = await gateway((entry, question) =>
      entry.id === oneSentence.id && question === "invented" ? probability : separating(entry, question)
    )

    const result = await run(at)

    expect(CompletionClaim.sentences(oneSentence.evidence.claim)).toHaveLength(1)
    expect(result.code).toBe(code)
    expect(result.report?.cases.find((graded) => graded.id === oneSentence.id)?.outcome).toBe(outcome)
    expect(result.report?.failures).toEqual(code === 0 ? [] : [`${oneSentence.id}: false_refusal`])
  })

  it.each([
    { entry: flatLie, outcome: "missed", code: 1 },
    { entry: undecidable, outcome: "missed_by_design", code: 0 }
  ])("grades the lie $entry.id read below the threshold as $outcome", async ({ code, entry, outcome }) => {
    const at = await gateway((each, question) => each.id === entry.id ? 0.84 : separating(each, question))

    const result = await run(at)

    expect(result.code).toBe(code)
    expect(result.report?.cases.find((graded) => graded.id === entry.id)).toMatchObject({ outcome, invented: 0.84 })
    expect(result.stderr.split("\n")[0]).toMatch(code === 0 ? /^calibrated: / : /^FAILED: .* 1 missed,/)
  })

  it("decides a long claim on its most invented sentence and keeps every sentence's reading", async () => {
    const at = await gateway((entry, question) =>
      entry.id !== fabricated.id ?
        separating(entry, question) :
        question === "sentence4" ?
        0.96 :
        question.startsWith("sentence") ?
        0.1 :
        0.9
    )

    const { report } = await run(at)

    const graded = report?.cases.find((each) => each.id === fabricated.id)
    expect(graded).toMatchObject({ outcome: "refused", invented: 0.96, whole: { invented: 0.9 } })
    expect(graded?.sentences?.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(graded?.sentences?.probabilities).toEqual(
      CompletionClaim.sentences(fabricated.evidence.claim).map((sentence, index) => ({
        sentence,
        probability: index === 3 ? 0.96 : 0.1
      }))
    )
    expect(at.requests.some((request) => request.questions.join() === "sentence1,sentence2,sentence3,sentence4"))
      .toBe(true)
  })

  it("fails every case the gateway refuses, with no probability filled in", async () => {
    const at = await gateway(separating, corpus.cases, { status: 401 })

    const { code, report } = await run(at)

    expect(code).toBe(1)
    expect(report?.counts).toMatchObject({ cases: 18, executed: 0, error: 18 })
    expect(report?.cases.every((graded) => graded.invented === undefined && graded.whole === undefined)).toBe(true)
    expect(report?.cases[0]?.error).toEqual({
      code: "completion_unjudged",
      message: "A completion no evaluator could judge (refused): The gateway answered 401"
    })
  })

  it("fails a case the brake does not read", async () => {
    const cases = [{ ...honest, id: "no-task", evidence: { ...honest.evidence, task: " " } }, flatLie]
    const at = await gateway(separating, cases)

    const result = await withCorpus({ cases }, (path) => run(at, ["--corpus", path]))

    expect(result.code).toBe(1)
    expect(result.report?.counts).toMatchObject({ cases: 2, executed: 1, skipped: 1, refused: 1 })
    expect(result.report?.failures).toEqual(["no-task: skipped"])
  })

  it("writes the report to --out and nothing to stdout", async () => {
    const at = await gateway(separating)
    const dir = scratch()
    try {
      const out = join(dir, "report.json")

      const result = await run(at, ["--out", out])

      expect(result.code).toBe(0)
      expect(result.stdout).toBe("")
      expect((JSON.parse(readFileSync(out, "utf8")) as Calibration.Report).counts.executed).toBe(18)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { name: "no invented case", value: { cases: [honest] }, says: "at least one invented case" },
    { name: "no honest case", value: { cases: [flatLie] }, says: "at least one honest case" },
    { name: "a repeated id", value: { cases: [honest, flatLie, { ...honest }] }, says: "unique" },
    { name: "an invented case with no decidable", value: { cases: [honest, { ...flatLie, decidable: undefined }] } }
  ])("refuses a corpus with $name before any request", async ({ says, value }) => {
    const at = await gateway(separating)

    const result = await withCorpus(value, (path) => run(at, ["--corpus", path]))

    expect(result.code).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("is not a valid calibration corpus")
    if (says !== undefined) expect(result.stderr).toContain(says)
    expect(at.requests).toEqual([])
  })

  const missing =
    "AI_GATEWAY_API_KEY is not set. The completion-claim calibration asks the live gateway and never skips.\n"

  it("exits 2 naming the missing credential when launched without it", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" }
    delete env["AI_GATEWAY_API_KEY"]

    // Starting Node and loading the module graph is slow on a loaded host.
    const result = spawnSync(process.execPath, [program], { env, encoding: "utf8", timeout: 90_000 })

    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe(missing)
  }, 100_000)

  it.each(["", "  "])("exits 2 before any request when the key is %j", async (key) => {
    const at = await gateway(separating)
    let stderr = ""

    const code = await Calibration.main([], { AI_GATEWAY_API_KEY: key, SMITHERS_EVALUATOR_BASE_URL: at.url }, {
      stdout: () => {
        throw new Error("nothing is written to stdout")
      },
      stderr: (text) => {
        stderr += text
      }
    })

    expect(code).toBe(2)
    expect(stderr).toBe(missing)
    expect(at.requests).toEqual([])
  })

  it("retains a passing live report of this corpus, these questions and this threshold", () => {
    const retained = JSON.parse(readFileSync(reportPath, "utf8")) as Calibration.Report
    const rerun = "Re-run it against the real gateway: node test/calibration/completionClaim.ts --out " +
      "test/calibration/completionClaimReport.json"

    expect(retained.source.corpus.sha256, rerun).toBe(sha256(corpusText))
    expect(retained.judge.classifier.digest, rerun).toBe(CompletionClaim.classifier.digest)
    expect(retained.judge.model, rerun).toBe(Evaluator.defaultModel)
    expect(retained.judge.baseUrl, rerun).toBe(Evaluator.defaultBaseUrl)
    expect(retained.threshold, rerun).toEqual({
      inventedAt: CompletionClaim.inventedAt,
      unsupportedAt: CompletionClaim.unsupportedAt
    })
    // Sentence questions decide long claims, so their wording is part of what was calibrated.
    const bySentence = retained.cases.filter((graded) => graded.sentences !== undefined)
    expect(bySentence.length, rerun).toBeGreaterThan(0)
    for (const graded of bySentence) {
      const entry = corpus.cases.find((each) => each.id === graded.id)!
      expect(graded.sentences?.digest, rerun).toBe(
        CompletionClaim.sentenceClassifier(CompletionClaim.sentences(entry.evidence.claim)).digest
      )
    }
    // Every retained outcome follows from its recorded reading and its label.
    expect(retained.cases.map((graded) => graded.id)).toEqual(corpus.cases.map((entry) => entry.id))
    for (const [index, graded] of retained.cases.entries()) {
      const entry = corpus.cases[index]!
      const refused = CompletionClaim.unrecorded({
        complete: 0,
        overclaims: 0,
        invented: graded.invented ?? Number.NaN
      })
      expect(graded.outcome, graded.id).toBe(
        entry.label === "honest"
          ? (refused ? "false_refusal" : "kept")
          : refused
          ? "refused"
          : entry.decidable
          ? "missed"
          : "missed_by_design"
      )
    }
    expect(retained.cases.filter((graded) => Calibration.failing.has(graded.outcome))).toEqual([])
    expect(retained.passed).toBe(true)
    expect(retained.counts).toMatchObject({ cases: corpus.cases.length, executed: corpus.cases.length })
  })
})
