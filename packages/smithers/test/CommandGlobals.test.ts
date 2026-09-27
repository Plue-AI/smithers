/**
 * The pre-handler every canonical verb owes.
 *
 * `Bin.test.ts` proves these promises through the real executable, so the
 * child process runs them and this one never sees the notices. These cases pin
 * the same promises in process: which environment is read when the invocation
 * carries none, that an ignored 0.x connection string is announced rather than
 * dropped, that a 0.x project is named once, and that an exported
 * `SMITHERS_BACKEND` refuses exactly as `--backend` does.
 */
import * as UnsupportedBackend from "@smthrs/database/UnsupportedBackend"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Globals from "../src/commands/Globals.ts"
import * as Environment from "../src/Environment.ts"
import * as Project from "../src/Project.ts"

const written: Array<string> = []

const capture = () =>
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })

afterEach(() => {
  written.length = 0
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const legacy = (found: ReadonlyArray<string>) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Project.LegacyState, found)

describe("the shared verb pre-handler", () => {
  it("announces every ignored 0.x connection string and names a 0.x project once", async () => {
    capture()
    await Effect.runPromise(
      Globals.notices({
        environment: { SMITHERS_POSTGRES_URL: "postgres://x", SMITHERS_TEST_PG_URL: "postgres://y" }
      }).pipe(legacy(["/project/.flows/state.db", "/project/.flows/journal.db"]))
    )
    expect(written).toEqual([
      `${UnsupportedBackend.ignoredNotice("SMITHERS_TEST_PG_URL")}\n`,
      // One digest for the whole project, off the snapshot the invocation took.
      `${Project.legacyNotice("/project/.flows/state.db")}\n`
    ])
  })

  it("reads the process environment when the invocation carries none", async () => {
    capture()
    vi.stubEnv("SMITHERS_POSTGRES_POOL_MAX", "8")
    await Effect.runPromise(Globals.notices({}).pipe(legacy([])))
    expect(written).toEqual([`${UnsupportedBackend.ignoredNotice("SMITHERS_POSTGRES_POOL_MAX")}\n`])
  })

  it("refuses an exported SMITHERS_BACKEND the way it refuses the flag", async () => {
    capture()
    const exported = await Effect.runPromise(
      Effect.flip(Globals.guard({ environment: { SMITHERS_BACKEND: "mysql" } }).pipe(legacy([])))
    )
    expect(exported.message).toBe(Environment.unsupportedBackendMessage)
    const flagged = await Effect.runPromise(
      Effect.flip(Globals.guard({ backend: "pglite", environment: {} }).pipe(legacy([])))
    )
    expect(flagged.message).toBe(Environment.unsupportedBackendMessage)
    // The refusal reaches the same place through the process environment.
    vi.stubEnv("SMITHERS_BACKEND", "mysql")
    const inherited = await Effect.runPromise(Effect.flip(Globals.guard({}).pipe(legacy([]))))
    expect(inherited.message).toBe(Environment.unsupportedBackendMessage)
    vi.unstubAllEnvs()
    // A supported backend passes the guard, says nothing, and reaches the
    // stores through the variable they read.
    vi.stubEnv("SMITHERS_BACKEND", "")
    await Effect.runPromise(Globals.guard({ backend: "postgres", environment: {} }).pipe(legacy([])))
    expect(process.env.SMITHERS_BACKEND).toBe("postgres")
    await Effect.runPromise(Globals.guard({ backend: "sqlite", environment: {} }).pipe(legacy([])))
    expect(process.env.SMITHERS_BACKEND).toBe("sqlite")
    vi.unstubAllEnvs()
    expect(written).toEqual([])
  })

  it("never prints the shared session token", async () => {
    const errors: Array<unknown> = []
    vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")))
    vi.stubEnv("SMITHERS_BACKEND", "")
    capture()
    await Effect.runPromise(
      Globals.guard({ backend: "sqlite", environment: { SMITHERS_TOKEN: "sk-secret" } }).pipe(legacy([]))
    )
    expect([...errors, ...written].join("")).not.toContain("sk-secret")
  })
})
