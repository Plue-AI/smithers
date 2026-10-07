import { test } from "bun:test"

/**
 * A release-trust test that only means something on macOS: Mach-O fixtures,
 * codesign, otool, the darwin-arm64 build guard, launchd. Off macOS it skips.
 * Its name carries the "[requires macOS]" tag so a macOS job can run exactly
 * these, `bun test scripts -t "requires macOS"`, and fail if any of them skips.
 */
export const requiresMacOS = (name: string, fn: () => void | Promise<void>, timeout?: number): void => {
  const run = test.skipIf(process.platform !== "darwin")
  if (timeout === undefined) run(`[requires macOS] ${name}`, fn)
  else run(`[requires macOS] ${name}`, fn, timeout)
}
