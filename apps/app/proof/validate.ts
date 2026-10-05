import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"
import { type MockJourney, MOCK_STEPS_PATH, readMockJourneys, renderMockSteps } from "./mock-steps.ts"
import { type Feature, featuresSchema, parseCodeRef, parseMockStepRef } from "./schema.ts"

/**
 * The proofValidate gate for .specs/product/features.json. Restored from
 * 2716e98558^:.smithers/lib/ddd/validateFeatures.ts (schema, unique ids) and
 * extended with the evidence contract's link checks: every mock step, proof
 * step, code range and docs page a feature names exists at HEAD.
 */

export const FEATURES_PATH = ".specs/product/features.json"

export type IssueKind =
  | "unreadable"
  | "schema"
  | "duplicate-id"
  | "mock-step-missing"
  | "proof-file-missing"
  | "proof-step-missing"
  | "implemented-without-proof"
  | "code-path-missing"
  | "code-range-out-of-bounds"
  | "docs-path-missing"
  | "spec-path-missing"
  | "gap-missing"
  | "gap-on-implemented"
  | "mock-steps-stale"

export interface Issue {
  readonly kind: IssueKind
  /** The feature the issue belongs to; absent for file-level issues. */
  readonly id?: string
  readonly message: string
}

/** The repository as the validator sees it: a fixed tree (HEAD, or the working tree for local edits). */
export interface RepoView {
  /** File contents, or undefined when the path is not a file in the tree. */
  read(path: string): string | undefined
}

const lineCount = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0))

/** Checks parsed features.json content against the schema, the mock and the tree. Pure: every input is passed in. */
export function validateFeatures(raw: unknown, repo: RepoView, mock: ReadonlyArray<MockJourney>): Issue[] {
  const parsed = featuresSchema.safeParse(raw)
  if (!parsed.success) return [{ kind: "schema", message: `${FEATURES_PATH} does not match the schema:\n${z.prettifyError(parsed.error)}` }]
  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const feature of parsed.data) {
    if (seen.has(feature.id)) issues.push({ kind: "duplicate-id", id: feature.id, message: `duplicate feature id ${feature.id}` })
    seen.add(feature.id)
    issues.push(...validateFeature(feature, repo, mock))
  }
  return issues
}

function validateFeature(feature: Feature, repo: RepoView, mock: ReadonlyArray<MockJourney>): Issue[] {
  const issues: Issue[] = []
  const issue = (kind: IssueKind, message: string) => issues.push({ kind, id: feature.id, message: `${feature.id}: ${message}` })

  for (const ref of feature.mockSteps) {
    const { journey, n } = parseMockStepRef(ref)
    const steps = mock.find(entry => entry.file === journey)?.steps
    if (steps === undefined) issue("mock-step-missing", `mock step ${ref}: no journey file ${journey} in ${MOCK_STEPS_PATH}`)
    else if (n > steps.length) issue("mock-step-missing", `mock step ${ref}: ${journey} has ${steps.length} steps`)
  }

  for (const proof of feature.proof) {
    const text = repo.read(proof.file)
    if (text === undefined) issue("proof-file-missing", `proof file ${proof.file} does not exist`)
    else if (!text.includes(proof.step)) issue("proof-step-missing", `proof file ${proof.file} has no step ${proof.step}`)
  }

  for (const ref of feature.code) {
    const { path, range } = parseCodeRef(ref)
    const text = repo.read(path)
    if (text === undefined) issue("code-path-missing", `code ${ref}: ${path} does not exist`)
    else if (range !== undefined && range.end > lineCount(text)) issue("code-range-out-of-bounds", `code ${ref}: ${path} has ${lineCount(text)} lines`)
  }

  for (const ref of feature.docs) {
    const path = ref.split("#", 1)[0]!
    if (repo.read(path) === undefined) issue("docs-path-missing", `docs ${ref}: ${path} does not exist`)
  }

  const specPath = feature.spec.split("#", 1)[0]!
  if (repo.read(specPath) === undefined) issue("spec-path-missing", `spec ${feature.spec}: ${specPath} does not exist`)

  if (feature.status === "not-implemented" && feature.gap.trim() === "") issue("gap-missing", "status not-implemented needs a one-line gap")
  if (feature.status === "implemented" && feature.gap.trim() !== "") issue("gap-on-implemented", "an implemented feature has no gap; clear it or mark the feature not-implemented")
  if (feature.status === "implemented" && feature.proof.length === 0) issue("implemented-without-proof", "status implemented needs at least one proof step")
  return issues
}

/** The committed mock-steps.json must equal what the mock renders today. */
export function validateMockSteps(committed: string | undefined, current: ReadonlyArray<MockJourney>): Issue[] {
  if (committed === undefined) return [{ kind: "mock-steps-stale", message: `${MOCK_STEPS_PATH} does not exist; run bun apps/app/proof/mock-steps.ts` }]
  return committed === renderMockSteps(current) ? [] : [{ kind: "mock-steps-stale", message: `${MOCK_STEPS_PATH} differs from the design mock; run bun apps/app/proof/mock-steps.ts` }]
}

/** The tree at a commit, read through git. */
export function gitTree(root: string, rev = "HEAD"): RepoView {
  const files = new Set(execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", rev], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 }).split("\0").filter(Boolean))
  const cache = new Map<string, string>()
  return {
    read(path) {
      if (!files.has(path)) return undefined
      let text = cache.get(path)
      if (text === undefined) {
        text = execFileSync("git", ["show", `${rev}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 })
        cache.set(path, text)
      }
      return text
    }
  }
}

/** The working tree, for checking uncommitted edits. */
export function workingTree(root: string): RepoView {
  return {
    read(path) {
      const absolute = resolve(root, path)
      try {
        return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined
      } catch {
        return undefined
      }
    }
  }
}

/** Runs every check on a tree: features.json and mock-steps.json from the tree, the mock rendered from the working tree's sources. */
export async function validateRepository(root: string, repo: RepoView): Promise<{ features: number; issues: Issue[] }> {
  const featuresText = repo.read(FEATURES_PATH)
  const mockText = repo.read(MOCK_STEPS_PATH)
  if (featuresText === undefined) return { features: 0, issues: [{ kind: "unreadable", message: `${FEATURES_PATH} does not exist` }] }
  let raw: unknown
  let mock: MockJourney[]
  try {
    raw = JSON.parse(featuresText)
  } catch (error) {
    return { features: 0, issues: [{ kind: "unreadable", message: `${FEATURES_PATH} is not JSON: ${error instanceof Error ? error.message : String(error)}` }] }
  }
  try {
    mock = mockText === undefined ? [] : (JSON.parse(mockText) as MockJourney[])
  } catch (error) {
    return { features: 0, issues: [{ kind: "unreadable", message: `${MOCK_STEPS_PATH} is not JSON: ${error instanceof Error ? error.message : String(error)}` }] }
  }
  const issues = [...validateMockSteps(mockText, await readMockJourneys(root)), ...validateFeatures(raw, repo, mock)]
  return { features: Array.isArray(raw) ? raw.length : 0, issues }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../../..")
  const worktree = process.argv.includes("--worktree")
  const { features, issues } = await validateRepository(root, worktree ? workingTree(root) : gitTree(root))
  const where = worktree ? "the working tree" : "HEAD"
  if (issues.length > 0) {
    console.error(`proofValidate failed at ${where}: ${issues.length} issue(s)`)
    for (const issue of issues) console.error(`- [${issue.kind}] ${issue.message}`)
    process.exit(1)
  }
  console.log(`proofValidate passed at ${where}: ${features} features.`)
}
