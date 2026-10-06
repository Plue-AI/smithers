import { startNativeBackend } from "./NativeBackendProcess"
import { nativeStateDirectory } from "./NativeState"

const stateDir = nativeStateDirectory()
const argument = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const publicOrigins = process.argv.flatMap((value, at) => value === "--origin" && process.argv[at + 1] ? [process.argv[at + 1]!] : [])
const backend = await startNativeBackend({
  stateDir,
  ...(argument("--bind") === undefined ? {} : { bind: argument("--bind")! }),
  publicOrigins,
  ...(process.argv.includes("--setup-handoff=socket") ? { setupHandoff: "socket" as const } : {})
})
const origin = backend.origin

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
