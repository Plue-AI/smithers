import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { MODE_DESCRIPTORS, owedScenarioIds } from "./matrix"
import type { DeploymentMode, RealE2EEvidenceFile } from "./types"

export interface EvidenceReference { readonly path: string; readonly sha256: string }
export interface ExpectedMatrixEvidence {
  readonly executionID: string
  readonly mode: DeploymentMode
  readonly origin: string
  readonly endpoint: string
  readonly revision: string
  readonly buildSha?: string
  readonly startedAt: string
  readonly finishedAt: string
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const instant = (value: unknown): number => typeof value === "string" ? Date.parse(value) : NaN
export const evidenceOrigin = (value: string): string => {
  const url = new URL(value)
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Evidence origin must be a credential-free HTTP(S) origin")
  return url.origin
}

/** Raw child receipts are authority; summary rows cannot repair absent or foreign evidence. */
export const validateRawMatrixEvidence = (value: unknown, expected: ExpectedMatrixEvidence): readonly string[] => {
  const errors: string[] = []
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(expected.executionID) || !/^[a-f0-9]{40,64}$/.test(expected.revision)) errors.push("expected execution identity is invalid")
  if (!Number.isFinite(instant(expected.startedAt)) || !Number.isFinite(instant(expected.finishedAt)) || instant(expected.finishedAt) < instant(expected.startedAt)) errors.push("expected invocation time is invalid")
  if (MODE_DESCRIPTORS[expected.mode].provider === "plue" && !/^[a-f0-9]{40,64}$/.test(expected.buildSha ?? "")) errors.push("expected deployment revision is missing")
  try { evidenceOrigin(expected.origin); evidenceOrigin(expected.endpoint) } catch { errors.push("expected invocation origin is invalid") }
  if (!object(value) || !Array.isArray(value.runs)) return ["raw child evidence is malformed"]
  if (value.suiteStatus !== "passed") errors.push("raw suite did not pass")
  if (!Array.isArray(value.reporterErrors) || value.reporterErrors.length !== 0) errors.push("raw reporter errors are present")
  const execution = value.execution
  if (!object(execution)) errors.push("raw execution identity is missing")
  else {
    for (const key of ["executionID", "mode", "origin", "endpoint"] as const) if (execution[key] !== expected[key]) errors.push(`raw ${key} differs from invocation`)
    const started = instant(execution.startedAt), finished = instant(execution.finishedAt)
    if (!Number.isFinite(started) || !Number.isFinite(finished) || started < instant(expected.startedAt) || finished < started || finished > instant(expected.finishedAt)) errors.push("raw execution time is outside invocation")
    try {
      if (typeof execution.surfaceOrigin !== "string") throw new Error()
      evidenceOrigin(execution.surfaceOrigin)
      if (execution.surfaceOrigin !== expected.origin) errors.push("raw surface differs from mode origin")
    } catch { errors.push("raw surface origin is invalid") }
  }
  const owed = owedScenarioIds(expected.mode), seen = new Set<string>()
  for (const run of value.runs) {
    if (!object(run) || typeof run.scenarioId !== "string" || !owed.includes(run.scenarioId)) { errors.push("raw receipt is not an owed scenario"); continue }
    if (seen.has(run.scenarioId)) errors.push(`duplicate raw receipt ${run.scenarioId}`)
    seen.add(run.scenarioId)
    if (run.status !== "passed" || run.mode !== expected.mode || run.host !== MODE_DESCRIPTORS[expected.mode].legacyHost || run.revision !== expected.revision) errors.push(`foreign or unsuccessful raw receipt ${run.scenarioId}`)
    if (MODE_DESCRIPTORS[expected.mode].provider === "plue" && run.buildSha !== expected.buildSha) errors.push(`raw deployment differs ${run.scenarioId}`)
    const started = instant(run.startedAt), finished = instant(run.finishedAt)
    if (!Number.isFinite(started) || !Number.isFinite(finished) || started < instant(expected.startedAt) || finished < started || finished > instant(expected.finishedAt)) errors.push(`raw receipt time is outside invocation ${run.scenarioId}`)
  }
  for (const id of owed) if (!seen.has(id)) errors.push(`missing raw receipt ${id}`)
  return errors
}

const safePath = (root: string, path: string): string => {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe evidence reference")
  const absolute = resolve(root, path), child = relative(resolve(root), absolute)
  if (child.startsWith(".." + sep) || isAbsolute(child)) throw new Error("Evidence reference escapes archive")
  return absolute
}
export const archiveEvidence = (root: string, path: string, bytes: Uint8Array): EvidenceReference => {
  const destination = safePath(root, path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, bytes, { mode: 0o600, flag: "wx" })
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") }
}
export const readEvidenceReference = (root: string, reference: EvidenceReference): Uint8Array => {
  const path = safePath(root, reference.path), stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_000_000 || !realpathSync(path).startsWith(realpathSync(root) + sep)) throw new Error("Invalid evidence artifact")
  const bytes = readFileSync(path)
  if (!/^[a-f0-9]{64}$/.test(reference.sha256) || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error("Evidence artifact hash mismatch")
  return bytes
}
export const rawEvidence = (root: string, reference: EvidenceReference): RealE2EEvidenceFile => JSON.parse(new TextDecoder().decode(readEvidenceReference(root, reference))) as RealE2EEvidenceFile
