import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Runs `/bin/ps` synchronously; injectable so inspection failures are testable. */
export type PsRunner = (args: ReadonlyArray<string>) => string

export const runPs: PsRunner = (args) =>
  execFileSync("/bin/ps", args, {
    encoding: "utf8",
    timeout: 1000,
    killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
  })

/** What one inspection established about a pid. */
export type Observation =
  | { readonly state: "absent" }
  | { readonly state: "zombie"; readonly command: string }
  | { readonly state: "running"; readonly command: string }

/**
 * Inspects `pid` through `ps`, failing loudly instead of guessing.
 *
 * `ps -p` exits 1 with no output for an unknown pid; that alone is absence,
 * and only when `kill(pid, 0)` agrees (ESRCH). A timeout, a spawn error, a
 * signal, any other status, or a disagreeing kill probe is a failed
 * inspection: reporting it as absence would let a teardown assertion pass on
 * a live owned process.
 */
export const inspect = (pid: number, run: PsRunner = runPs): Observation => {
  let output: string
  try {
    output = run(["-ww", "-o", "stat=,command=", "-p", String(pid)]).trim()
  } catch (error) {
    const failure = error as {
      readonly status?: number | null
      readonly signal?: string | null
      readonly stdout?: unknown
    }
    const stdout = typeof failure.stdout === "string" ? failure.stdout.trim() : ""
    if (failure.status !== 1 || (failure.signal ?? null) !== null || stdout !== "") {
      throw new Error(`process inspection of ${pid} failed`, { cause: error })
    }
    try {
      process.kill(pid, 0)
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === "ESRCH") return { state: "absent" }
      throw new Error(`process inspection of ${pid} failed`, { cause: probe })
    }
    throw new Error(`ps reported ${pid} absent but it still accepts signals`)
  }
  if (output === "") throw new Error(`ps exited 0 without describing ${pid}`)
  return output.startsWith("Z") ? { state: "zombie", command: output } : { state: "running", command: output }
}

export const until = async (check: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(10)
  }
  throw new Error("contained-command fixture did not reach its ready state")
}

interface Record {
  readonly token: string
  readonly pid: number
  readonly tick?: number
}

export const fixture = async (
  options: { readonly natural: boolean; readonly inheritedOutput: boolean; readonly ps?: PsRunner }
) => {
  const observe = (pid: number) => inspect(pid, options.ps)
  const directory = await mkdtemp(join(tmpdir(), "smithers-build-child-"))
  const token = randomUUID()
  const beatPath = join(directory, "beat.json")
  const leaderPath = join(directory, "leader.json")
  const exitPath = join(directory, "exit")
  const read = async (path: string): Promise<Record | undefined> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record
    } catch {
      return undefined
    }
  }
  const child = `const fs=require('node:fs');const token=${JSON.stringify(token)};const path=${
    JSON.stringify(beatPath)
  };let tick=0;process.on('SIGTERM',()=>{});const beat=()=>{fs.writeFileSync(path+'.tmp',JSON.stringify({token,pid:process.pid,tick:tick++}));fs.renameSync(path+'.tmp',path)};beat();setInterval(beat,20)`
  const leader = `const fs=require('node:fs');const{spawn}=require('node:child_process');const token=${
    JSON.stringify(token)
  };fs.writeFileSync(${
    JSON.stringify(leaderPath)
  },JSON.stringify({token,pid:process.pid}));process.on('SIGTERM',()=>process.exit(0));spawn(process.execPath,['-e',${
    JSON.stringify(child)
  }],{stdio:${
    options.inheritedOutput ? "['ignore','inherit','inherit']" : "'ignore'"
  }}).unref();setInterval(()=>{if(fs.existsSync(${JSON.stringify(beatPath)})&&(${
    options.natural ? "true" : `fs.existsSync(${JSON.stringify(exitPath)})`
  }))process.stdout.write('target-complete\\n',()=>process.exit(0))},5)`
  return {
    directory,
    token,
    argv: [process.execPath, "-e", leader] as const,
    beat: () => read(beatPath),
    ready: () => until(async () => (await read(beatPath))?.token === token),
    exit: () => writeFile(exitPath, "go"),
    leader: () => read(leaderPath),
    /** Whether the process is absent or a zombie; throws when inspection fails. */
    stopped: (record: Record) => observe(record.pid).state !== "running",
    /**
     * Kills this fixture's own surviving processes, then removes its records.
     * An inspection failure rejects and keeps the records, so a teardown is
     * never reported as complete over an unverified survivor.
     */
    dispose: async () => {
      for (const path of [beatPath, leaderPath]) {
        const record = await read(path)
        if (record?.token !== token) continue
        const observed = observe(record.pid)
        // Only the unique process created by this fixture may be cleaned up.
        if (observed.state !== "running" || !observed.command.includes(token)) continue
        process.kill(record.pid, "SIGKILL")
        await until(async () => observe(record.pid).state !== "running")
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
}
