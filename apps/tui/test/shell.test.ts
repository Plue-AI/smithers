import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import * as Shell from "../src/shell.ts"
import * as Transcript from "../src/transcript.ts"

const bashExecutable = Bun.which("bash")

describe("shell output", () => {
  it("empty SHELL uses available POSIX shell", async () => {
    const result = await Shell.run({
      command: "printf '%s 中文 🦉' \"$0\"",
      cwd: tmpdir(),
      env: { SHELL: "", PATH: "" },
      onOutput: () => {}
    }).done
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe("/bin/sh 中文 🦉")
  })

  it("uses a POSIX shell when SHELL is unset and Bash is absent from PATH", async () => {
    const result = await Shell.run({
      command: "printf '%s 中文 🦉' \"$0\"",
      cwd: tmpdir(),
      env: { PATH: "" },
      onOutput: () => {}
    }).done
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe("/bin/sh 中文 🦉")
  })

  it.skipIf(bashExecutable === null)(
    "uses an explicitly configured POSIX shell even when Bash is on PATH",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "smithers-shell-"))
      try {
        const bash = join(directory, "bash")
        symlinkSync(bashExecutable!, bash)
        const result = await Shell.run({
          command: "printf '%s 中文 🦉' \"$0\"",
          cwd: directory,
          env: { SHELL: "/bin/sh", PATH: directory },
          onOutput: () => {}
        }).done
        expect(result.exitCode).toBe(0)
        expect(result.output).toBe("/bin/sh 中文 🦉")
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(bashExecutable === null)(
    "uses executable Bash on PATH for unset and empty SHELL, skipping a non-executable candidate",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "smithers-shell-"))
      try {
        const blockedDirectory = join(directory, "blocked")
        const executableDirectory = join(directory, "executable")
        mkdirSync(blockedDirectory)
        mkdirSync(executableDirectory)
        writeFileSync(join(blockedDirectory, "bash"), "#!/bin/sh\nprintf blocked\n", { mode: 0o644 })
        const bash = join(executableDirectory, "bash")
        symlinkSync(bashExecutable!, bash)
        const path = [blockedDirectory, executableDirectory].join(delimiter)
        for (const env of [{ PATH: path }, { SHELL: "", PATH: path }]) {
          const result = await Shell.run({
            command: "printf '%s 中文 🦉' \"$0\"",
            cwd: directory,
            env,
            onOutput: () => {}
          }).done
          expect(result.exitCode).toBe(0)
          expect(result.output).toBe(`${bash} 中文 🦉`)
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it("preserves an explicitly configured shell's startup failure", async () => {
    const result = await Shell.run({
      command: "printf unexpected",
      cwd: tmpdir(),
      env: { SHELL: "/missing-tui-shell", PATH: process.env.PATH },
      onOutput: () => {}
    }).done
    expect(result.exitCode).toBe(127)
    expect(result.output).toContain("missing-tui-shell")
  })

  it("stops a resistant child even when it closed the shell's output pipes", async () => {
    let ready = () => {}
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    let child: number | undefined
    let group: number | undefined
    let armed = false
    const run = Shell.run({
      command:
        "echo group-ready-$$; (trap '' TERM HUP; echo child-ready >&3; exec 3>&-; exec sleep 30) 3>&1 >/dev/null 2>&1 & echo child-pid-$!; wait",
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, SHELL: "/bin/bash" },
      onOutput: (text) => {
        const parent = /group-ready-(\d+)/.exec(text)
        const found = /child-pid-(\d+)/.exec(text)
        if (parent !== null) group = Number(parent[1])
        if (found !== null) child = Number(found[1])
        if (text.includes("child-ready")) armed = true
        if (child !== undefined && armed) ready()
      }
    })
    try {
      await started
      run.cancel()
      expect((await run.done).cancelled).toBe(true)
      const deadline = Date.now() + 1000
      while (Date.now() < deadline) {
        try {
          process.kill(child!, 0)
        } catch {
          break
        }
        await Bun.sleep(20)
      }
      expect(() => process.kill(child!, 0)).toThrow()
    } finally {
      if (group !== undefined) {
        try {
          process.kill(-group, "SIGKILL")
        } catch {}
      }
    }
  }, 10_000)

  it("stops a SIGTERM-resistant process group and settles cancellation once", async () => {
    let started = () => {}
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let pid: number | undefined
    const run = Shell.run({
      command: "trap '' TERM; echo resistant-ready-$$; sleep 30",
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, SHELL: "/bin/bash" },
      onOutput: (text) => {
        const found = /resistant-ready-(\d+)/.exec(text)
        if (found !== null) {
          pid = Number(found[1])
          started()
        }
      }
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await ready
      const start = Date.now()
      run.cancel()
      run.cancel()
      const outcome = await Promise.race([
        run.done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("cancel did not settle")), Shell.cancelGraceMs + 2000)
        })
      ])
      expect(outcome.cancelled).toBe(true)
      expect(outcome.exitCode).toBeNull()
      expect(Date.now() - start).toBeLessThan(Shell.cancelGraceMs + 1500)
      expect(() => run.cancel()).not.toThrow()
      expect(() => process.kill(-pid!, 0)).toThrow()
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {}
      }
      await run.done
    }
  }, 10_000)

  it("decodes and redacts across real subprocess writes before streaming or spilling", async () => {
    const env = { PATH: process.env.PATH, SHELL: "/bin/bash", TEST_API_KEY: "synthetic-boundary-secret-value" }
    const streamed: Array<string> = []
    const command =
      `python3 -c 'import os,time; b="中文 👩🏽‍💻".encode(); [(os.write(1,bytes([v])),time.sleep(.005)) for v in b]; os.write(1,b"\\n"); os.write(1,b"synthetic-boundary-"); time.sleep(.1); os.write(1,b"secret-value\\n"); os.write(1,b"\\x1b[3"); time.sleep(.1); os.write(1,b"1mRED\\x1b[0m\\n"); os.write(1,b"x"*60000)'`
    const result = await Shell.run({ command, cwd: tmpdir(), env, onOutput: (text) => streamed.push(text) }).done
    const expected = "中文 👩🏽‍💻\n[redacted $TEST_API_KEY]\nRED\n" + "x".repeat(60000)
    expect(result.exitCode).toBe(0)
    expect(streamed.join("")).toBe(expected)
    expect(readFileSync(result.fullOutputPath!, "utf8")).toBe(expected)
    expect(result.output).not.toContain("synthetic-boundary-secret-value")
    expect(result.output).not.toContain("�")
  }, 20_000)
  it("masks credential-named environment values in the output it shows, saves and sends", async () => {
    const env = { ...process.env, GH_TOKEN: "ghp_supersecretvalue", HARMLESS: "ghp_supersecretvalue_not" }
    const streamed: Array<string> = []
    const result = await Shell.run({
      command: "echo $GH_TOKEN",
      cwd: tmpdir(),
      env,
      onOutput: (text) => streamed.push(text)
    })
      .done
    expect(result.output).toBe("[redacted $GH_TOKEN]")
    expect(streamed.join("")).not.toContain("ghp_supersecretvalue")
  }, 20_000)

  it("keeps a !! command's output out of the session record", () => {
    const result = { command: "cat .env", output: "KEY=1", exitCode: 0, cancelled: false, fullOutputPath: "/tmp/x" }
    expect(Shell.persisted(result, true)).toEqual({ command: "cat .env", output: "", exitCode: 0, cancelled: false })
    expect(Shell.persisted(result, false)).toBe(result)
  })

  it("streams output over the limit to an owner-only file and keeps only a bounded tail in memory", async () => {
    const result = await Shell.run({
      command: "i=0; while [ $i -lt 3000 ]; do printf '%0200d\\n' $i; i=$((i+1)); done",
      cwd: tmpdir(),
      onOutput: () => {}
    }).done
    expect(result.fullOutputPath).toBeDefined()
    expect(statSync(result.fullOutputPath!).mode & 0o777).toBe(0o600)
    expect(readFileSync(result.fullOutputPath!, "utf8").split("\n").filter((line) => line !== "")).toHaveLength(3000)
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(Shell.maxBytes)
    expect(result.output.endsWith(String(2999).padStart(200, "0"))).toBe(true)
  }, 20_000)

  it("settles with the kept tail when the full-output file cannot be written", async () => {
    const result = await Shell.run({
      command: "i=0; while [ $i -lt 3000 ]; do printf '%0200d\\n' $i; i=$((i+1)); done",
      cwd: tmpdir(),
      spillDir: "/nonexistent-smithers-spill-dir",
      onOutput: () => {}
    }).done
    expect(result.exitCode).toBe(0)
    expect(result.fullOutputPath).toBeUndefined()
    expect(result.output.endsWith(String(2999).padStart(200, "0"))).toBe(true)
  }, 20_000)

  it("batches a burst of output into few screen updates", async () => {
    let updates = 0
    let text = ""
    await Shell.run({
      command: "i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done",
      cwd: tmpdir(),
      onOutput: (chunk) => {
        updates++
        text += chunk
      }
    }).done
    expect(text.trim().split("\n")).toHaveLength(2000)
    expect(updates).toBeLessThan(50)
  }, 20_000)
})

describe("Transcript.shellOutput", () => {
  it("keeps only the tail of a running command's live output", () => {
    const start = Transcript.shellStart(Transcript.empty, "yes", false)
    const id = start.items[0]!.id
    let transcript = start
    for (let index = 0; index < 400; index++) transcript = Transcript.shellOutput(transcript, id, "y\n".repeat(1000))
    const item = transcript.items[0] as Extract<Transcript.Item, { kind: "shell" }>
    expect(item.output).toBe(Shell.tail("y\n".repeat(400_000)).text)
  })
})
