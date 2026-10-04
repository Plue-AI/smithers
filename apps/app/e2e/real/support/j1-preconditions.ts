import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"

export class J1PreconditionError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`C-J1-04 precondition/${code}: ${detail}`)
    this.name = "J1PreconditionError"
  }
}

// Human observations are supplied by the independent operator, never manufactured by the test.
const preconditions = z.object({
  stage: z.enum(["S1", "R"]),
  operator: z.object({ name: z.string().min(1), didNotBuildTickets: z.literal(true), instructions: z.enum(["bundle README", "quickstart"]) }),
  host: z.object({ referenceMini: z.literal(true), freshMacOSUser: z.literal(true), erased: z.literal(true), macOSMajor: z.number().int().min(15), homebrew: z.literal(true), profile: z.record(z.string(), z.unknown()) }),
  fresh: z.object({ install: z.literal(true), repository: z.literal(true), modelCache: z.literal(true), noSmithersFiles: z.literal(true), canaryTemplate: z.literal(true), detectedTestCommand: z.string().min(1) }),
  owner: z.literal("canary-owner"),
  repository: z.string().regex(/^smithers-mvp-canary\/\d{4}-\d{2}-\d{2}[\w-]*$/),
  t0: z.string().datetime(),
  clockOffsetStartMs: z.number().finite(), // host UTC minus NTP UTC
  recording: z.string().min(1),
  setupURL: z.string().url(),
  install: z.object({ version: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/) })
})

export function requireJ1Preconditions() {
  const baseURL = process.env.SMITHERS_REAL_BASE_URL ?? process.env.SMITHERS_E2E_BASE_URL
  if (!baseURL) throw new J1PreconditionError("install_missing", "SMITHERS_REAL_BASE_URL (or SMITHERS_E2E_BASE_URL) must name a fresh reference install; no development host is started")
  const path = process.env.SMITHERS_J1_PRECONDITIONS
  if (!path) throw new J1PreconditionError("human_evidence_missing", "SMITHERS_J1_PRECONDITIONS must name the independent operator's JSON evidence")
  try {
    if (!["http:", "https:"].includes(new URL(baseURL).protocol)) throw new Error("install URL must use HTTP or HTTPS")
    const parsed = preconditions.parse(JSON.parse(readFileSync(path, "utf8")))
    if (new URL(parsed.setupURL).origin !== new URL(baseURL).origin) throw new Error("setup URL must belong to the declared install")
    if (parsed.operator.instructions !== (parsed.stage === "S1" ? "bundle README" : "quickstart")) throw new Error("instructions must match the stage")
    const correctedT0 = Date.parse(parsed.t0) - parsed.clockOffsetStartMs
    if (correctedT0 > Date.now() || Date.now() - correctedT0 > 3_600_000) throw new Error("recording T0 must be within the activation window")
    if (!statSync(parsed.recording).isFile() || statSync(parsed.recording).size === 0) throw new Error("full screen recording must exist and be nonempty")
    if (!process.env.SMITHERS_J1_REVIEW) throw new Error("SMITHERS_J1_REVIEW must name the operator review evidence")
    if (!process.env.SMITHERS_J1_FINAL_EVIDENCE) throw new Error("SMITHERS_J1_FINAL_EVIDENCE must name the operator's end-of-run attestation")
    if (process.env.SMITHERS_REAL_HEADED !== "1") throw new Error("SMITHERS_REAL_HEADED=1 is required for the independent operator's setup and review")
    process.env.SMITHERS_REAL_BASE_URL = baseURL
    process.env.SMITHERS_REAL_E2E_HOST ??= "local"
    process.env.SMITHERS_J1_ACTIVATION = "1"
    process.env.SMITHERS_REAL_E2E_ARTIFACTS ??= resolve("../../.artifacts/checks/C-J1-04", new Date().toISOString().replaceAll(":", "-"))
    return parsed
  } catch (cause) {
    throw new J1PreconditionError("human_evidence_invalid", cause instanceof Error ? cause.message : String(cause))
  }
}
