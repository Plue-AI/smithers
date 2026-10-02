import { join, resolve } from "node:path"
import { startNativeBackend } from "./NativeBackendProcess"
import { nativeStateDirectory } from "./NativeState"
import { defaultDistDir } from "./server"

const stateDir = Bun.env.SMITHERS_LOCAL_STATE_DIR?.trim()
  ? resolve(Bun.env.SMITHERS_LOCAL_STATE_DIR)
  : join(nativeStateDirectory(), "headless")
const backend = await startNativeBackend({ stateDir, webRoot: defaultDistDir(import.meta.dir) })
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
