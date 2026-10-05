#!/usr/bin/env bun
/*
 * Show a Codex session in the app's components: the timeline rail, the
 * conversation and the run monitor with its scrubber.
 *
 *   bun scripts/codex-session.ts <session id | id prefix | rollout path> [--out <file.html>] [--serve] [--no-open]
 *
 * Without --serve it writes one self-contained HTML file (default
 * ~/Desktop/codex-sessions/<id>.html) and opens it. With --serve it serves the
 * page on localhost and re-reads the rollout every five seconds, for a session
 * that is still running.
 */
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readRollout } from "../src/mainview/codexSession/CodexRollout"

const here = fileURLToPath(new URL(".", import.meta.url))
const mainview = resolve(here, "../src/mainview")

/** Every sessions directory a Codex home on this machine can hold, CODEX_HOME first. */
export async function sessionRoots(home = homedir(), env = process.env): Promise<string[]> {
  const roots = [env.CODEX_HOME ? join(env.CODEX_HOME, "sessions") : "", join(home, ".codex", "sessions")]
  const accounts = join(home, ".smithers", "accounts")
  for (const name of await readdir(accounts).catch(() => [] as string[])) if (name.startsWith("codex")) roots.push(join(accounts, name, "sessions"))
  return [...new Set(roots.filter(Boolean))]
}

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) yield path
  }
}

/** The newest rollout whose session id starts with `id`, across every Codex home; a path is taken as is. */
export async function findRollout(id: string, roots: readonly string[]): Promise<string> {
  if (id.endsWith(".jsonl")) return resolve(id)
  const matches: Array<{ path: string; modified: number }> = []
  for (const root of roots) for await (const path of walk(root)) {
    const sessionId = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(path)?.[1]
    if (sessionId?.startsWith(id)) matches.push({ path, modified: (await stat(path)).mtimeMs })
  }
  const ids = new Set(matches.map(match => /-([0-9a-f-]{36})\.jsonl$/.exec(match.path)?.[1]))
  if (matches.length === 0) throw new Error(`No Codex rollout for ${id} under ${roots.join(", ")}`)
  if (ids.size > 1) throw new Error(`${id} matches ${ids.size} sessions: ${[...ids].join(", ")}`)
  // A session copied into several homes: the copy written last is the live one.
  return matches.sort((left, right) => right.modified - left.modified)[0]!.path
}

async function bundle(): Promise<{ script: string; styles: string }> {
  const build = await Bun.build({ entrypoints: [join(mainview, "codexSession/main.tsx")], target: "browser", minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") } })
  if (!build.success) throw new AggregateError(build.logs, "The session page did not build")
  const script = await build.outputs.find(output => output.kind === "entry-point")!.text()
  const font = async (pkg: string, file: string, family: string, weight: number) =>
    `@font-face{font-family:"${family}";font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${(await readFile(Bun.resolveSync(`@fontsource/${pkg}/files/${file}`, here))).toString("base64")}) format("woff2")}`
  const fonts = await Promise.all([font("inter", "inter-latin-400-normal.woff2", "Inter", 400), font("inter", "inter-latin-500-normal.woff2", "Inter", 500),
    font("inter", "inter-latin-600-normal.woff2", "Inter", 600), font("ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2", "IBM Plex Mono", 400)])
  const sheets = await Promise.all(["styles/tokens.css", "styles/base.css", "styles/cards.css", "styles/chrome.css", "codexSession/codex-session.css"]
    .map(path => readFile(join(mainview, path), "utf8")))
  return { script, styles: [...fonts, ...sheets].join("\n") }
}

/** `<` is escaped so neither the data nor the script can close their element early. */
const inline = (value: string): string => value.replace(/</g, "\\u003c")

export function page(title: string, styles: string, script: string, data: { readonly json?: string; readonly live?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title.replace(/[<&]/g, "")}</title><style>${styles}</style></head><body><div id="root"></div>` +
    `<script type="application/json" id="codex-session"${data.live ? ` data-live="${data.live}"` : ""}>${data.json === undefined ? "null" : inline(data.json)}</script>` +
    `<script type="module">${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`
}

async function personName(): Promise<{ name: string; login: string } | undefined> {
  const run = Bun.spawnSync(["jj", "config", "get", "user.name"], { stdout: "pipe", stderr: "ignore" })
  const name = run.success ? run.stdout.toString().trim() : ""
  return name === "" ? undefined : { name, login: name.toLowerCase().replace(/\s+/g, "") }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string) => args.includes(name)
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
  const id = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--out")
  if (id === undefined) { console.error("usage: bun scripts/codex-session.ts <session id | prefix | rollout.jsonl> [--out file.html] [--serve] [--no-open]"); process.exit(2) }
  const rollout = await findRollout(id, await sessionRoots())
  const person = await personName()
  const read = async () => JSON.stringify({ session: readRollout(await readFile(rollout, "utf8")), person })
  const { script, styles } = await bundle()
  if (flag("--serve")) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: Number(option("--port") ?? 0), fetch: async request =>
      new URL(request.url).pathname === "/session.json"
        ? new Response(await read(), { headers: { "content-type": "application/json", "cache-control": "no-store" } })
        : new Response(page(`Codex ${id}`, styles, script, { live: "/session.json" }), { headers: { "content-type": "text/html" } }) })
    console.log(`${rollout}\n${server.url}`)
    if (!flag("--no-open")) Bun.spawn(["open", server.url.href])
  } else {
    const json = await read()
    const session = (JSON.parse(json) as { session: { id: string } }).session
    const out = resolve(option("--out") ?? join(homedir(), "Desktop", "codex-sessions", `${session.id || id}.html`))
    await mkdir(resolve(out, ".."), { recursive: true })
    await writeFile(out, page(`Codex ${session.id.slice(0, 8)}`, styles, script, { json }))
    console.log(`${rollout}\n${out} (${(Buffer.byteLength(json) / 1e6).toFixed(1)} MB of session data)`)
    if (!flag("--no-open")) Bun.spawn(["open", out])
  }
}
