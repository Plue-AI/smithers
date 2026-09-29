import { describe, expect, it } from "vitest"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"

describe("contained process capture", () => {
  it.each([7, 8, 9])("enforces the output ceiling in bytes at %s bytes", async (size) => {
    let stdout = ""
    const pending = ContainedProcess.run({
      command: process.execPath,
      args: ["-e", `process.stdout.write(Buffer.concat([Buffer.from("é"), Buffer.alloc(${size - 2}, 120)]))`],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxOutputBytes: 8,
      stdout: (text) => {
        stdout += text
      },
      stderr: () => {}
    })
    if (size <= 8) {
      expect(await pending).toBe(0)
      expect(stdout).toBe(`é${"x".repeat(size - 2)}`)
    } else {
      await expect(pending).rejects.toMatchObject({ _tag: "smithers-build/ProcessError", code: "output_limit" })
    }
  })

  it("decodes a character split across pipe chunks", async () => {
    let stdout = ""
    expect(
      await ContainedProcess.run({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50)"
        ],
        cwd: process.cwd(),
        timeoutMs: 5000,
        fatalUtf8: true,
        stdout: (text) => {
          stdout += text
        },
        stderr: () => {}
      })
    ).toBe(0)
    expect(stdout).toBe("é")
  })

  it("refuses incomplete UTF-8 rather than renaming a git path", async () => {
    await expect(ContainedProcess.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(Buffer.from([0xc3]))"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      fatalUtf8: true,
      stdout: () => {},
      stderr: () => {}
    })).rejects.toMatchObject({
      _tag: "smithers-build/ProcessError",
      code: "process_failed",
      cause: expect.any(TypeError)
    })
  })
})
