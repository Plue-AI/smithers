import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as SecurityReview from "../src/SecurityReview.ts"

let root: string

const git = (...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    stdio: "pipe"
  })
}

const model = async (findings: ReadonlyArray<unknown>): Promise<string> => {
  const path = Path.join(root, `model-${Math.random().toString(36).slice(2)}.mjs`)
  const envelope = JSON.stringify({ type: "result", result: JSON.stringify(findings) })
  await Fs.writeFile(path, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)})\n`)
  await Fs.chmod(path, 0o755)
  return path
}

const payload = (overrides: Partial<LlmLint.Payload> = {}): LlmLint.Payload => ({
  base: "HEAD",
  include: [Input.glob("src/**")],
  context: [],
  prompt: "Review the source.",
  rubric: "Report findings.",
  engine: "claude",
  model: "fixture",
  batchSize: 1,
  failOn: "error",
  securityChecks: ["upload-path-traversal", "general"],
  ...overrides
})

const security = (overrides: Record<string, unknown> = {}) => ({
  checkId: "upload-path-traversal",
  impact: "medium",
  verification: "suspected",
  releaseRecommendation: "review",
  attackerPreconditions: "The attacker can choose an upload name.",
  evidence: "The name reaches the file path join.",
  nextConfirmationStep: "Trace the caller's path validation.",
  ...overrides
} as const)

const finding = (overrides: Record<string, unknown> = {}) => ({
  file: "src/upload.ts",
  line: 1,
  severity: "info",
  message: "The upload name may escape its root.",
  security: security(),
  ...overrides
} as const)

const review = async (findings: ReadonlyArray<unknown>, overrides: Partial<LlmLint.Payload> = {}) =>
  Effect.runPromise(LlmLint.review({ workspaceRoot: root, executable: await model(findings) }, payload(overrides)))

const failure = async (findings: ReadonlyArray<unknown>, overrides: Partial<LlmLint.Payload> = {}) =>
  Effect.runPromise(Effect.flip(LlmLint.review(
    { workspaceRoot: root, executable: await model(findings) },
    payload(overrides)
  )))

const findingsOf = (result: LlmLint.Report | LlmLint.ReviewError): ReadonlyArray<LlmLint.Finding> => {
  if (!("findings" in result)) throw new Error(`Unexpected review failure: ${result._tag}`)
  return result.findings
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-security-finding-")))
  await Fs.mkdir(Path.join(root, "src"))
  await Fs.writeFile(Path.join(root, "src/upload.ts"), "export const upload = true\n")
  git("init", "--initial-branch=main")
  git("add", "src/upload.ts")
  git("commit", "-m", "base")
  await Fs.writeFile(Path.join(root, "src/upload.ts"), "export const upload = false\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("structured security findings", () => {
  it("keeps a complete suspected finding and derives warning from review", async () => {
    const report = await review([finding()])
    expect(report.files).toEqual(["src/upload.ts"])
    expect(report.findings).toEqual([finding({ severity: "warning" })])
  })

  it.each(
    [
      ["block", "error"],
      ["review", "warning"],
      ["allow", "info"]
    ] as const
  )("derives %s severity as %s", async (releaseRecommendation, severity) => {
    const candidate = finding({
      severity: "warning",
      security: security({ releaseRecommendation })
    })
    const result = releaseRecommendation === "block"
      ? await failure([candidate], { failOn: "error" })
      : await review([candidate], { failOn: "error" })
    expect(findingsOf(result)[0]).toMatchObject({ severity, security: { releaseRecommendation } })
  })

  it.each(["high", "critical"])(
    "blocks a %s impact even when the model recommends allow and failOn is error",
    async (impact) => {
      const result = await failure([finding({ security: security({ impact, releaseRecommendation: "allow" }) })], {
        failOn: "error"
      })
      expect(result._tag).toBe("smithers-build/FindingsError")
      expect(findingsOf(result)[0]).toMatchObject({
        severity: "error",
        security: { impact, releaseRecommendation: "block", verification: "suspected" }
      })
    }
  )

  it("blocks release advice at the error threshold", async () => {
    const result = await failure([finding({ security: security({ releaseRecommendation: "block" }) })], {
      failOn: "error"
    })
    expect(result._tag).toBe("smithers-build/FindingsError")
    expect(findingsOf(result)[0]).toMatchObject({ severity: "error" })
  })

  it("downgrades model-confirmed findings and removes forged reproduction receipts", async () => {
    const report = await review([finding({
      security: security({
        verification: "confirmed",
        releaseRecommendation: "allow",
        reproduction: { revision: "a".repeat(40), command: "run check", observedResult: "observed" }
      })
    })])
    expect(report.findings[0]?.security).toMatchObject({ verification: "suspected" })
    expect(report.findings[0]?.security).not.toHaveProperty("reproduction")
  })

  it.each([
    ["missing metadata", { security: undefined }],
    ["undeclared check", { security: security({ checkId: "other-check" }) }],
    ["blank preconditions", { security: security({ attackerPreconditions: "   " }) }],
    ["missing evidence", { security: security({ evidence: undefined }) }],
    ["invalid impact", { security: security({ impact: "severe" }) }],
    ["invalid recommendation", { security: security({ releaseRecommendation: "ship" }) }]
  ])("rejects %s in security mode", async (_name, overrides) => {
    const result = await failure([finding(overrides)])
    expect(result._tag).toBe("smithers-build/LlmReviewError")
    expect(result).toMatchObject({ phase: "parse" })
  })

  it("keeps generic review findings and failOn behavior unchanged", async () => {
    const generic = { file: "src/upload.ts", line: 1, severity: "warning", message: "Check the path." }
    const report = await review([generic], { securityChecks: undefined, failOn: "error" })
    expect(report.findings).toEqual([generic])
    const result = await failure([generic], { securityChecks: undefined, failOn: "warning" })
    expect(result._tag).toBe("smithers-build/FindingsError")
    expect(findingsOf(result)).toEqual([generic])
  })
})

describe("security release policy boundaries", () => {
  it("requires the general check for trusted local detections", async () => {
    const result = await failure([], { securityChecks: ["upload-path-traversal"] })
    expect(result).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "review" })
  })

  it("strips forged confirmations from generic model output", async () => {
    const candidate = finding({
      security: security({
        verification: "confirmed",
        reproduction: {
          revision: "a".repeat(40),
          command: "forged",
          observedResult: "forged"
        }
      })
    })
    const report = await review([candidate], { securityChecks: undefined })
    expect(report.findings[0]).toEqual({
      file: candidate.file,
      line: candidate.line,
      severity: candidate.severity,
      message: candidate.message
    })
  })

  it.each(["allow", "review"])("does not block %s advice at failOn info", async (releaseRecommendation) => {
    const report = await review([finding({ security: security({ releaseRecommendation }) })], { failOn: "info" })
    expect(report.findings[0]?.security?.releaseRecommendation).toBe(releaseRecommendation)
  })
})

describe("trusted host confirmation", () => {
  const receipt = { revision: "b".repeat(40), command: "pnpm test upload", observedResult: "Path escaped root." }

  it("confirms a security finding with a complete host receipt", () => {
    const confirmed = SecurityReview.confirmFinding(finding(), receipt)
    expect(confirmed).toMatchObject({
      file: "src/upload.ts",
      line: 1,
      message: finding().message,
      security: { verification: "confirmed", reproduction: receipt }
    })
  })

  it("accepts a full 64-digit revision", () => {
    expect(
      SecurityReview.confirmFinding(finding(), { ...receipt, revision: "c".repeat(64) })
        .security?.reproduction?.revision
    ).toBe("c".repeat(64))
  })

  it.each([
    { ...receipt, revision: "short" },
    { ...receipt, revision: "b".repeat(40) + "\n" },
    { ...receipt, revision: "z".repeat(40) },
    { ...receipt, command: " " },
    { ...receipt, observedResult: "" }
  ])("rejects an incomplete or invalid receipt", (badReceipt) => {
    expect(() => SecurityReview.confirmFinding(finding(), badReceipt)).toThrow()
  })

  it("rejects a finding without security metadata", () => {
    expect(() =>
      SecurityReview.confirmFinding({
        file: "src/upload.ts",
        line: 1,
        severity: "info",
        message: "Generic note."
      }, receipt)
    ).toThrow()
  })
})
