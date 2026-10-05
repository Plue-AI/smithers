/*
 * The fixture Codex CLI (#3730): `codex exec … -- <prompt>` as the T1 host runs it. It writes one
 * Codex 0.160 rollout under $CODEX_HOME/sessions/YYYY/MM/DD, as Codex does, for a session that
 * started in this directory now: the prompt, a command, and an answer that quotes the prompt.
 * Real Codex never runs in a test.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const prompt = process.argv.at(-1) ?? ""
const home = process.env.CODEX_HOME
if (!home) throw new Error("The fixture Codex CLI needs CODEX_HOME.")
const session = crypto.randomUUID()
const started = new Date()
const pad = (value: number) => String(value).padStart(2, "0")
const day = join(home, "sessions", String(started.getFullYear()), pad(started.getMonth() + 1), pad(started.getDate()))
const stamp = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}T${pad(started.getHours())}-${pad(started.getMinutes())}-${pad(started.getSeconds())}`
const at = (offset: number) => new Date(started.getTime() + offset).toISOString()
const item = (offset: number, payload: Record<string, unknown>) =>
  ({ timestamp: at(offset), type: "event_msg", payload: { type: "item_completed", thread_id: session, turn_id: "t1", ...payload, started_at_ms: 0, completed_at_ms: 0 } })
const lines = [
  { timestamp: at(0), type: "session_meta", payload: { id: session, session_id: session, timestamp: at(0), cwd: process.cwd(), originator: "codex_exec", cli_version: "0.160.0" } },
  { timestamp: at(1), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
  item(2, { item: { type: "UserMessage", content: [{ type: "text", text: prompt }] } }),
  item(3, { item: { type: "CommandExecution", id: "exec-1", command: ["/bin/zsh", "-lc", "ls"], parsed_cmd: [{ type: "unknown", cmd: "ls" }], status: "completed", exit_code: 0, aggregated_output: "" } }),
  item(4, { item: { type: "AgentMessage", phase: "final_answer", content: [{ type: "Text", text: `Fixture Codex finished: ${prompt}` }] } }),
  { timestamp: at(5), type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: `Fixture Codex finished: ${prompt}` } }
]
mkdirSync(day, { recursive: true })
writeFileSync(join(day, `rollout-${stamp}-${session}.jsonl`), lines.map(line => `${JSON.stringify(line)}\n`).join(""))
