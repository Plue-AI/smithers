import { expect, test } from "bun:test"
import { homedir } from "node:os"
import { nativeStateDirectory } from "./NativeState"

// Controlled configuration units: no directory is created or inspected and
// no subprocess is launched. The real home-directory authority is untouched.
const withLocation = (platform: NodeJS.Platform, dataHome: string | undefined, assertion: () => void) => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!
  const previousDataHome = Bun.env.XDG_DATA_HOME
  const hadDataHome = Object.hasOwn(Bun.env, "XDG_DATA_HOME")
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform })
    if (dataHome === undefined) delete Bun.env.XDG_DATA_HOME
    else Bun.env.XDG_DATA_HOME = dataHome
    assertion()
    expect(Bun.env.XDG_DATA_HOME).toBe(dataHome)
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor)
    if (hadDataHome) Bun.env.XDG_DATA_HOME = previousDataHome
    else delete Bun.env.XDG_DATA_HOME
    expect(Object.getOwnPropertyDescriptor(process, "platform")).toEqual(platformDescriptor)
    expect(Object.hasOwn(Bun.env, "XDG_DATA_HOME")).toBe(hadDataHome)
    expect(Bun.env.XDG_DATA_HOME).toBe(previousDataHome)
  }
}

test.each([
  { name: "unset", dataHome: undefined },
  { name: "absolute override", dataHome: "/var/lib/native-fixture" },
  { name: "empty override", dataHome: "" }
])("macOS uses Application Support when XDG_DATA_HOME is $name", ({ dataHome }) => {
  withLocation("darwin", dataHome, () => {
    expect(nativeStateDirectory()).toBe(`${homedir()}/Library/Application Support/Smithers`)
  })
})

test("non-macOS uses the home data directory when XDG_DATA_HOME is unset", () => {
  withLocation("linux", undefined, () => {
    expect(nativeStateDirectory()).toBe(`${homedir()}/.local/share/smithers`)
  })
})

test.each([
  { dataHome: "/var/lib/native-fixture", expected: "/var/lib/native-fixture/smithers" },
  { dataHome: "/var/lib/native-fixture/", expected: "/var/lib/native-fixture/smithers" },
  { dataHome: "/var/lib/Native Data/café", expected: "/var/lib/Native Data/café/smithers" }
])("non-macOS preserves the absolute data location $dataHome", ({ dataHome, expected }) => {
  withLocation("linux", dataHome, () => {
    expect(nativeStateDirectory()).toBe(expected)
  })
})

// XDG Base Directory Specification: unset or empty uses the default;
// relative environment paths are invalid and must be ignored.
test.each([
  { name: "empty", dataHome: "" },
  { name: "relative", dataHome: "native-data" },
  { name: "dot-relative", dataHome: "./native-data" }
])("non-macOS ignores $name XDG_DATA_HOME and uses the home fallback", ({ dataHome }) => {
  withLocation("linux", dataHome, () => {
    expect(nativeStateDirectory()).toBe(`${homedir()}/.local/share/smithers`)
  })
})
