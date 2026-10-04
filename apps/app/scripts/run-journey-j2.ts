import { referenceOrigin, JourneyUnavailable } from "../e2e/real/todo/reference"

const spec = process.argv[2]
if (!["todo-from-issue", "todo-needs-you", "todo-evidence", "todo-merge"].includes(spec)) throw new Error("Unknown J2 journey")
try { referenceOrigin() } catch (error) {
  if (!(error instanceof JourneyUnavailable)) throw error
  console.error(JSON.stringify({ code: error.code, class: error.class, message: error.message }))
  process.exit(1)
}
// Reuse the real-host config, including host preflight, artifact reporter and
// real credential handling. No isolated local server may stand in for install.
const child = Bun.spawn(["pnpm", "exec", "playwright", "test", "--config", "playwright.real.config.ts", `e2e/real/${spec}.spec.ts`], {
  cwd: import.meta.dir + "/..", env: { ...process.env, SMITHERS_CHAT_STUB: "0", SMITHERS_JOURNEY: `${spec}.spec.ts` }, stdin: "inherit", stdout: "inherit", stderr: "inherit"
})
process.exit(await child.exited)
