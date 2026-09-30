import { describe, expect, test } from "bun:test"
import { nativeUrlOpenHost } from "./NativeWrapper"

describe("nativeUrlOpenHost", () => {
  test("is absent off macOS, where the wrapper registers no URL scheme", () => {
    expect(nativeUrlOpenHost("linux", ["/usr/lib/libSystem.B.dylib"])).toBeNull()
    expect(nativeUrlOpenHost("win32", [])).toBeNull()
  })

  test("is absent when no candidate is a wrapper that exports setURLOpenHandler", () => {
    expect(nativeUrlOpenHost("darwin", [])).toBeNull()
    expect(nativeUrlOpenHost("darwin", ["/nonexistent/libNativeWrapper.dylib"])).toBeNull()
    // A library that loads but lacks the symbol is not the wrapper.
    expect(nativeUrlOpenHost("darwin", ["/usr/lib/libSystem.B.dylib"])).toBeNull()
  })
})
