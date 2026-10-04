import { startNativeBackend } from "./NativeBackendProcess"
import { nativeStateDirectory } from "./NativeState"

const stateDir = nativeStateDirectory()
const backend = await startNativeBackend({
  stateDir,
  ...(process.argv.includes("--setup-handoff=socket") ? { setupHandoff: "socket" as const } : {})
})
const origin = backend.mode === "own" ? backend.origin : Bun.env.SMITHERS_API_ORIGIN?.trim()
if (origin === undefined || origin === "") {
  await backend.stop()
  throw new Error("SMITHERS_API_ORIGIN is required in Plue mode.")
}

await new Promise<void>((resolveShutdown) => {
  let stopping = false
  const stop = (failure?: Error): void => {
    if (stopping) return
    stopping = true
    if (failure !== undefined) {
      console.error(failure.message)
      process.exitCode = 1
    }
    void backend.stop().then(resolveShutdown, (error) => {
      console.error(error)
      process.exitCode = 1
      resolveShutdown()
    })
  }
  process.on("SIGINT", () => stop())
  process.on("SIGTERM", () => stop())
  void backend.failure?.then((failure) => {
    if (failure !== undefined) stop(failure)
  })
  console.log(`SMITHERS_LOCAL_ORIGIN=${origin}`)
})
