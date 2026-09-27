/**
 * The Shell `hosts` attr: the declaration is host-independent data carried
 * as target metadata, and only a rule that maps it restricts a target.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as CiToolchain from "../src/CiToolchain.ts"
import * as Docker from "../src/Docker.ts"
import * as Input from "../src/Input.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"

describe("hosts", () => {
  it("restricts a shell declaration to the hosts it names", () => {
    for (const make of [Shell.Test, Shell.Run]) {
      expect(Target.metadata(make({ shell: "true", hosts: ["linux"] })).hosts).toEqual(["linux"])
    }
    expect(Target.metadata(Shell.Build({ shell: "true", outFiles: ["a"], hosts: ["darwin"] })).hosts).toEqual([
      "darwin"
    ])
  })

  it("leaves an unrestricted declaration on every host", () => {
    expect(Target.metadata(Shell.Test({ shell: "true" })).hosts).toBeUndefined()
  })

  it("does not read an OCI platforms attr as a host restriction", () => {
    const image = Docker.Build({ dockerfile: Input.file("Dockerfile"), context: ".", platforms: ["linux/amd64"] })
    expect(Target.metadata(image).hosts).toBeUndefined()
  })

  it("refuses an empty list and an unknown host", () => {
    expect(() => Shell.Test({ shell: "true", hosts: [] as never })).toThrow()
    expect(() => Shell.Test({ shell: "true", hosts: ["plan9"] as never })).toThrow()
  })

  it("shares the host vocabulary with CI Cargo binaries", () => {
    const binary = { package: "p", binary: "b", toolchain: "1.98.0", environment: "B", platforms: ["plan9"] }
    expect(() => Schema.decodeUnknownSync(CiToolchain.CargoBinary)(binary)).toThrow()
    expect(Schema.decodeUnknownSync(CiToolchain.CargoBinary)({ ...binary, platforms: ["win32"] }).platforms)
      .toEqual(["win32"])
  })
})
