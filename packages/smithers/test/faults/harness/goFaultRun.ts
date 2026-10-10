/**
 * Runs one Go-backed fault case as a Vitest case. Both fault tiers use it, so a
 * case moved between tiers keeps exactly the same acceptance rules.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { requireReachedGoFaultMatrix, requireRebaseRecoveryObservations } from "./durability.ts"
import { githubCrossings, requireGitHubRecoveryObservations } from "./githubFaultMatrix.ts"
import { type FaultTier, type GoFaultCase, goFaultCasesFor, requiredFaultSiblings } from "./goFaultCases.ts"
import { machineTodoPoints, requireTodoRecoveryObservations } from "./todoFaultMatrix.ts"

export const workspaceRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const backend = `${workspaceRoot}packages/backend`

/**
 * Programs the fault targets build and name in their declared `env`. The
 * declaration can only hold a fixed string, so it holds a workspace-relative
 * path; a Go case runs in its own package directory and some cases refuse a
 * relative helper, so the path is made absolute before any case starts.
 */
export const declaredPrograms = [
  "SMITHERS_FAULT_POSTGRES_BIN",
  "SMITHERS_FAULT_INSTALL_BUNDLE",
  "SMITHERS_CHECK_BUNDLE",
  "SMITHERS_FFI_LIBRARY_PATH",
  "SMITHERS_REHEARSAL_JJ_EXPORT_BINARY",
  "SMITHERS_REHEARSAL_MACHINED_BINARY",
  "SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY"
] as const

/** The environment a Go case runs under: the declared one, with absolute program paths. */
export const goFaultEnvironment = (extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const name of declaredPrograms) {
    const value = env[name]
    if (value !== undefined && value !== "" && !isAbsolute(value)) env[name] = resolve(workspaceRoot, value)
  }
  return env
}

/** The declared host class. A target that names none ran with its declaration lost (#3459). */
export const requireFaultHost = (): void => {
  expect(["linux", "reference"], "SMITHERS_FAULT_HOST must name the host class the fault target declares")
    .toContain(process.env.SMITHERS_FAULT_HOST)
}

const caseEnvironment = (entry: GoFaultCase): Record<string, string> =>
  entry.file === "internal/compose/github_outbound_kill_test.go"
    ? { SMITHERS_GITHUB_OUTBOUND_KILL: "1" }
    : entry.name === "TestTodoStartPauseResumeCrashThroughRoutes"
    ? { SMITHERS_TODO_PAUSE_HOST_KILL: "1" }
    : entry.file === "internal/compose/rebase_fault_test.go"
    ? {
      SMITHERS_REBASE_FAULT_REQUIRED: "1",
      ...(process.env.SMITHERS_FAULT_HOST === "reference" ? { SMITHERS_REBASE_FAULT_REFERENCE: "1" } : {})
    }
    : {}

// The leaves that carry each case's kill markers, when they are not the
// selected top-level tests themselves.
const evidenceNames = (entry: GoFaultCase, names: ReadonlyArray<string>): ReadonlyArray<string> =>
  entry.file === "internal/compose/github_outbound_kill_test.go"
    ? githubCrossings.map((crossing) => `TestGitHubOutboundKillProductionProposal/${crossing}/crossing`)
    : entry.name === "TestTodoMachineKillThroughInstall"
    ? machineTodoPoints.map((point) => `${entry.name}/${point}/crossing`)
    : entry.name === "TestTodoStartPauseResumeCrashThroughRoutes"
    ? ["stop", "resume"].map((point) => `${entry.name}/${point}`)
    : names

/** Registers one Vitest case per Go case of `tier` on this host. */
export const registerGoFaultCases = (tier: FaultTier): void => {
  // These TypeScript siblings are executed by their tier's FaultSuite once
  // present. Absence must fail rather than reduce the matrix silently.
  for (const [file, owner] of Object.entries(requiredFaultSiblings)) {
    if (owner !== tier) continue
    test(`required fault sibling: ${file}`, () => {
      expect(
        existsSync(`${workspaceRoot}packages/smithers/test/faults/${file}`),
        `Missing production fault case: ${file}`
      )
        .toBe(true)
    })
  }
  for (const entry of goFaultCasesFor(tier, process.env.SMITHERS_FAULT_HOST)) {
    test(`${entry.check}: ${entry.name ?? entry.file}`, () => {
      expect(existsSync(`${backend}/${entry.file}`), `Missing production fault case: ${entry.file}`).toBe(true)
      requireFaultHost()
      expect(process.env.SMITHERS_TEST_DATABASE_URL, "Real PostgreSQL is required").toBeTruthy()
      const pkg = entry.file.slice(0, entry.file.lastIndexOf("/"))
      // Sibling tickets own their test names. Select only the functions in
      // their declared case file, never the entire package's unrelated tests.
      const names = entry.name ? [entry.name] : [
        ...readFileSync(`${backend}/${entry.file}`, "utf8").matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)
      ]
        .map((match) => match[1]!).filter((name) => !name.includes("Child"))
      expect(names.length, `No acceptance tests in ${entry.file}`).toBeGreaterThan(0)
      const result = spawnSync(
        "go",
        ["test", "-json", "-count=1", `./${pkg}`, "-run", `^(${names.join("|")})$`, "-timeout", entry.budget.go],
        {
          cwd: backend,
          env: goFaultEnvironment(caseEnvironment(entry)),
          encoding: "utf8",
          timeout: entry.budget.spawnMs,
          maxBuffer: 32 << 20
        }
      )
      // Preserve partial JSON and stderr before checking exit status: crashes,
      // compile errors and timeouts are precisely the failures this tier needs.
      console.log(result.stdout ?? "")
      console.error(result.stderr ?? "")
      expect(result.error, "Go fault process failed to execute").toBeUndefined()
      expect(result.signal, "Go fault process terminated by a signal").toBeNull()
      expect(result.status, "Go fault process exited unsuccessfully").toBe(0)
      if (entry.file === "internal/compose/rebase_fault_test.go") {
        requireRebaseRecoveryObservations(
          result.stdout,
          entry.name!,
          entry.name === "TestRebaseFaultRootInputsValidatedBeforeUse"
        )
      } else requireReachedGoFaultMatrix(result.stdout, evidenceNames(entry, names), entry.points)
      if (entry.file === "internal/compose/github_outbound_kill_test.go") {
        requireGitHubRecoveryObservations(result.stdout)
      }
      if (entry.name === "TestTodoMachineKillThroughInstall") requireTodoRecoveryObservations(result.stdout, "machine")
    }, entry.budget.testMs)
  }
}
