import { nativeTarget } from "./target.mjs"

// Literal platform branches let Bun's compiled target discard other platforms.
// The standard file loader embeds the same vendored bytes in a standalone TUI.
nativeTarget()
const path = async () => {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return (await import("./darwin-arm64/libopentui.dylib", { with: { type: "file" } })).default
    if (process.arch === "x64") return (await import("./darwin-x64/libopentui.dylib", { with: { type: "file" } })).default
  }
  if (process.platform === "linux") {
    if (process.arch === "arm64") {
      if (process.env.OPENTUI_LIBC === "musl") return (await import("./linux-arm64-musl/libopentui.so", { with: { type: "file" } })).default
      return (await import("./linux-arm64/libopentui.so", { with: { type: "file" } })).default
    }
    if (process.arch === "x64") {
      if (process.env.OPENTUI_LIBC === "musl") return (await import("./linux-x64-musl/libopentui.so", { with: { type: "file" } })).default
      return (await import("./linux-x64/libopentui.so", { with: { type: "file" } })).default
    }
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return (await import("./win32-arm64/opentui.dll", { with: { type: "file" } })).default
    if (process.arch === "x64") return (await import("./win32-x64/opentui.dll", { with: { type: "file" } })).default
  }
  throw new Error(`Unsupported OpenTUI native target: ${nativeTarget()}`)
}
export default await path()
