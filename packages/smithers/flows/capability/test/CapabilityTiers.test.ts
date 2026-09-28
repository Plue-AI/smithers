import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"

/**
 * `tierOf` decides whether a write is compensable (undoable from the workspace
 * snapshot) or irreversible. Its containment check normalizes `.` and `..`
 * lexically, so the interesting boundaries are relative workspace roots, roots
 * that normalize away entirely, and resources that climb out of the root.
 */

const write = (resource: string): Capability.Capability => Capability.make("fs:write", resource)

describe("Capability.tierOf containment boundaries", () => {
  it("confines relative resources under a relative workspace root", () => {
    // Root `..` cannot be reduced further, so it stays as a `..` segment and
    // everything resolved beneath it is still inside the workspace.
    expect(Capability.tierOf(write("file.txt"), { workspaceRoot: ".." })).toBe("compensable")
    expect(Capability.tierOf(write("nested/deep/file.txt"), { workspaceRoot: ".." })).toBe("compensable")
    // One extra `..` climbs above the relative root and is irreversible.
    expect(Capability.tierOf(write("../../file.txt"), { workspaceRoot: ".." })).toBe("irreversible")
  })

  it("keeps stacked parent segments in a relative root instead of dropping them", () => {
    // `../..` must not collapse to `..`: a resource resolved beneath the root
    // stays inside, but any resource that climbs back out is irreversible even
    // though its text still shares the root's `../` prefix.
    expect(Capability.tierOf(write("a/b"), { workspaceRoot: "../.." })).toBe("compensable")
    expect(Capability.tierOf(write("../a"), { workspaceRoot: "../.." })).toBe("irreversible")
    expect(Capability.tierOf(write(".."), { workspaceRoot: "../.." })).toBe("irreversible")
  })

  it("treats a workspace root that normalizes to nothing as untrusted", () => {
    // `work/..` reduces to the current directory, which the kernel refuses to
    // treat as a compensable snapshot boundary: it fails closed.
    expect(Capability.tierOf(write("file.txt"), { workspaceRoot: "work/.." })).toBe("irreversible")
    expect(Capability.tierOf(write("/abs/file.txt"), { workspaceRoot: "work/.." })).toBe("irreversible")
  })

  it("fails closed when a relative root is the current directory", () => {
    // `.` has no stable lexical boundary. A relative write therefore cannot
    // be represented as a compensable workspace operation. An empty root has
    // the same normalized boundary, while an absolute root always retains its
    // slash prefix and therefore cannot normalize to the empty string.
    expect(Capability.tierOf(write("file.txt"), { workspaceRoot: "." })).toBe("irreversible")
    expect(Capability.tierOf(write("file.txt"), { workspaceRoot: "" })).toBe("irreversible")
    expect(Capability.tierOf(write("/file.txt"), { workspaceRoot: "/" })).toBe("compensable")
  })

  it("resolves an absolute root back to itself after redundant segments", () => {
    expect(Capability.tierOf(write("/workspace/a"), { workspaceRoot: "/workspace/./nested/.." }))
      .toBe("compensable")
    // Parent traversal above a filesystem root is discarded rather than
    // converted into a relative path.
    expect(Capability.tierOf(write("/workspace/a"), { workspaceRoot: "/../workspace" }))
      .toBe("compensable")
    expect(Capability.tierOf(write("/workspaceX/a"), { workspaceRoot: "/workspace" })).toBe("irreversible")
  })

  it("treats the workspace root itself as inside the workspace", () => {
    expect(Capability.tierOf(write("/workspace"), { workspaceRoot: "/workspace" })).toBe("compensable")
    expect(Capability.tierOf(write("/workspace"), { workspaceRoot: "/workspace/" })).toBe("compensable")
  })

  it("compares drive-shaped path text exactly under POSIX lexical rules", () => {
    expect(Capability.tierOf(write("/C:/Work/file.txt"), { workspaceRoot: "/C:/Work" }))
      .toBe("compensable")
    expect(Capability.tierOf(write("/C:/Work/file.txt"), { workspaceRoot: "/c:/work" }))
      .toBe("irreversible")
  })

  it("never places a drive-lettered resource inside the workspace", () => {
    // A Windows resolver roots `a:/X/file` at a drive, so POSIX lexical
    // containment beneath the relative root `A:/x` cannot vouch for it.
    expect(Capability.tierOf(write("a:/X/file"), { workspaceRoot: "A:/x" })).toBe("irreversible")
  })
})

describe("Capability.format over patterns", () => {
  it("renders a pattern as durable `action:resource` key input", () => {
    expect(
      Capability.format(new Capability.CapabilityPattern({ action: "fs:*", resource: "/workspace/**" }))
    ).toBe("fs:*:/workspace/**")
    expect(
      Capability.format(new Capability.CapabilityPattern({ action: "*", resource: "**" }))
    ).toBe("*:**")
  })

  it("distinguishes patterns that differ only in resource", () => {
    const left = new Capability.CapabilityPattern({ action: "fs:write", resource: "/a/**" })
    const right = new Capability.CapabilityPattern({ action: "fs:write", resource: "/b/**" })
    expect(Capability.format(left)).not.toBe(Capability.format(right))
  })

  it("renders a capability and a pattern with the same bytes (D9)", () => {
    // `format`, the deleted `formatPattern`, and the inline copy in
    // `JournalGrantStore` had byte-identical bodies over structurally
    // identical records. Collapsing them to one renderer is only safe if the
    // bytes do not move, and those bytes reach durable journal payloads — so
    // they are pinned exactly here rather than left to a round trip.
    expect(Capability.format(new Capability.Capability({ action: "fs:read", resource: "src/index.ts" })))
      .toBe("fs:read:src/index.ts")
    expect(Capability.format(new Capability.CapabilityPattern({ action: "fs:read", resource: "src/index.ts" })))
      .toBe("fs:read:src/index.ts")
    // A plain record renders identically, which is what lets one signature
    // serve both classes.
    expect(Capability.format({ action: "net:get", resource: "api.example.com" }))
      .toBe("net:get:api.example.com")
  })

  it("rejects an invalid structural action before rendering durable bytes", () => {
    expect(() => Capability.format({ action: "fs" as Capability.Action, resource: "read:/x" }))
      .toThrow(/fs/)
  })
})
