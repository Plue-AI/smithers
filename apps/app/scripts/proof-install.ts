// The proof tier's plain helpers (EVIDENCE-CONTRACT.md): real-model keys, the
// launcher's argv, the bundle ports lock and the proof-step ledger. They live
// outside e2e/proof so the unit suite tests them; e2e/proof/fixtures.ts wires
// them into Playwright.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const KEY_NAMES = ["AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY", "OPENAI_API_KEY"] as const
export type KeyName = typeof KEY_NAMES[number]
/** The owner's real provider keys: the Gateway serves coding and Decisions, Cerebras the fast model. */
export type Keys = Readonly<Partial<Record<KeyName, string>>> & { readonly AI_GATEWAY_API_KEY: string; readonly CEREBRAS_API_KEY: string }

/**
 * Reads `NAME=value` lines (an `export ` prefix and one pair of quotes are
 * allowed; blank lines and `#` comments are skipped). Errors name the line,
 * never its value.
 */
export const parseKeys = (text: string): Keys => {
  const keys: Partial<Record<KeyName, string>> = {}
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) return
    const at = line.indexOf("=")
    const name = at < 0 ? "" : line.slice(0, at).trim().replace(/^export\s+/, "")
    if (!(KEY_NAMES as readonly string[]).includes(name)) throw new Error(`keys line ${index + 1}: expected ${KEY_NAMES.join(", ")} as NAME=value`)
    let value = line.slice(at + 1).trim()
    if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    if (value.length < 8 || /\s/.test(value)) throw new Error(`keys line ${index + 1}: ${name} has no usable value`)
    if (keys[name as KeyName] !== undefined) throw new Error(`keys line ${index + 1}: ${name} appears twice`)
    keys[name as KeyName] = value
  })
  for (const required of ["AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY"] as const) {
    if (keys[required] === undefined) throw new Error(`the keys file has no ${required}`)
  }
  return keys as Keys
}

/** A keys file only its owner may read (chmod 600), parsed. */
export const readKeys = (path: string): Keys => {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must be readable by its owner only: chmod 600 ${path}`)
  return parseKeys(readFileSync(path, "utf8"))
}

/** text with every key value replaced by `<key>`: an attached log or page text never carries a key. */
export const redact = (text: string, keys: Partial<Record<KeyName, string>>): string =>
  Object.values(keys).filter((value): value is string => typeof value === "string" && value.length >= 8)
    .sort((a, b) => b.length - a.length)
    .reduce((out, value) => out.split(value).join("<key>"), text)

/** The launcher (scripts/run-local-no-github.ts) argv for one proof install. */
export const launcherArgs = (options: { readonly out: string; readonly bundle?: string; readonly models: "real" | "standin"; readonly owner: string }): string[] => [
  "scripts/run-local-no-github.ts", "--no-browser", `--out=${options.out}`, `--models=${options.models}`, `--owner=${options.owner}`,
  ...(options.bundle === undefined ? [] : [`--bundle=${options.bundle}`])
]

/**
 * The bundle ports lock (~/lanes/f6-bundle-ports.lock on the mini): a
 * directory whose `owner` file says who holds it. A proof install writes
 * `proof <lane> pid <pid> <ISO time>`; a lock whose proof holder died is taken
 * over, and any other holder (a walk) is waited for.
 */
export const LOCK_OWNER = /^proof (\S+) pid (\d+) /
export interface LockOptions {
  readonly lane: string
  readonly pid?: number
  readonly alive?: (pid: number) => boolean
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  /** How long to wait for another holder; the default is 90 minutes. */
  readonly waitMs?: number
  readonly pollMs?: number
  readonly onWait?: (owner: string) => void
}
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}
export const takeLock = async (dir: string, options: LockOptions): Promise<void> => {
  const pid = options.pid ?? process.pid, alive = options.alive ?? pidAlive, now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const deadline = now() + (options.waitMs ?? 90 * 60_000)
  for (;;) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, "owner"), `proof ${options.lane} pid ${pid} ${new Date(now()).toISOString()}\n`)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    let owner = ""
    try { owner = readFileSync(join(dir, "owner"), "utf8").trim() } catch {}
    const held = LOCK_OWNER.exec(owner)
    if (held && Number(held[2]) !== pid && !alive(Number(held[2]))) {
      rmSync(dir, { recursive: true, force: true })
      continue
    }
    if (now() >= deadline) throw new Error(`the ports lock ${dir} is still held: ${owner || "no owner file"}`)
    options.onWait?.(owner)
    await sleep(options.pollMs ?? 30_000)
  }
}
/** Removes the lock only while this process holds it. */
export const releaseLock = (dir: string, pid = process.pid): boolean => {
  let owner = ""
  try { owner = readFileSync(join(dir, "owner"), "utf8") } catch { return false }
  if (Number(LOCK_OWNER.exec(owner)?.[2]) !== pid) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** A feature id as features.json spells it: lower-case words joined by hyphens. */
export const FEATURE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export type ProofStatus = "passed" | "failed" | "blocked"
/** One spec's proof steps, in order: what passed, and what a later step that needs it is blocked by. */
export class ProofLedger {
  readonly #status = new Map<string, ProofStatus>()
  /** Refuses a malformed or repeated feature id: each feature is proven once per spec. */
  begin(id: string): void {
    if (!FEATURE_ID.test(id)) throw new Error(`proof step id ${JSON.stringify(id)} is not a feature id`)
    if (this.#status.has(id)) throw new Error(`proof step ${id} runs twice in one spec`)
  }
  /** The first needed feature that did not pass, with why; undefined when every need passed. */
  blocker(needs: readonly string[]): string | undefined {
    for (const need of needs) {
      const status = this.#status.get(need)
      if (status === undefined) return `${need} (not run)`
      if (status !== "passed") return need
    }
    return undefined
  }
  record(id: string, status: ProofStatus): void { this.#status.set(id, status) }
  get entries(): ReadonlyArray<readonly [string, ProofStatus]> { return [...this.#status] }
}
