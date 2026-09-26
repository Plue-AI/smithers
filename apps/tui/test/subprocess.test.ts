import { describe, expect, it } from "bun:test"
import * as Subprocess from "../src/subprocess.ts"

describe("Subprocess", () => {
  it("finds a program on PATH like Bun.which", () => {
    expect(Subprocess.which("sh", process.env)).toBe(Bun.which("sh"))
    expect(Subprocess.which("smithers-no-such-program", process.env)).toBeNull()
    expect(Subprocess.which("sh", { PATH: "" })).toBeNull()
  })

  it("streams stdout and reports the exit status", async () => {
    const child = Subprocess.spawn(["sh", "-c", "printf hello; exit 3"], { cwd: process.cwd() })
    expect(await new Response(child.stdout).text()).toBe("hello")
    expect(await child.exited).toBe(3)
  })

  it("rejects exited when the program cannot start", async () => {
    const child = Subprocess.spawn(["smithers-no-such-program"], { cwd: process.cwd() })
    await expect(child.exited).rejects.toThrow()
  })
})
