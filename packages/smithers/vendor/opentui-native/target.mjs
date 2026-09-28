/** Match OpenTUI's platform and explicit OPENTUI_LIBC selection. */
export const nativeTarget = (platform = process.platform, arch = process.arch, libc = process.env.OPENTUI_LIBC) => {
  if (platform === "linux" && libc !== undefined && libc !== "" && libc !== "glibc" && libc !== "musl") {
    throw new Error(`Unsupported OpenTUI libc: ${libc}`)
  }
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported OpenTUI native target: ${platform}-${arch}`)
  }
  return `${platform}-${arch}${platform === "linux" && libc === "musl" ? "-musl" : ""}`
}
