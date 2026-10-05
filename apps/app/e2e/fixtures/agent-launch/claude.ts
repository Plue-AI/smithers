/*
 * The fixture Claude Code CLI (#3730): `claude -p … -- <prompt>` as the T1 host runs it. It writes one Claude Code
 * 2.1 transcript at $CLAUDE_CONFIG_DIR/projects/<project>/<session>.jsonl, as Claude Code does, for a session that
 * started in this directory now: the prompt, a command and its result, and an answer that quotes the prompt.
 * Real Claude Code never runs in a test.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const prompt = process.argv.at(-1) ?? ""
const home = process.env.CLAUDE_CONFIG_DIR
if (!home) throw new Error("The fixture Claude Code CLI needs CLAUDE_CONFIG_DIR.")
const session = crypto.randomUUID()
const cwd = process.cwd()
const started = Date.now()
const project = join(home, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"))
const base = { isSidechain: false, userType: "external", entrypoint: "cli", cwd, sessionId: session, version: "2.1.277", gitBranch: "main" }
const at = (offset: number) => new Date(started + offset).toISOString()
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const lines = [
  { type: "mode", mode: "normal", sessionId: session },
  { ...base, parentUuid: null, promptId: "p1", type: "user", uuid: uuid(1), timestamp: at(0), message: { role: "user", content: prompt } },
  { ...base, parentUuid: uuid(1), type: "assistant", uuid: uuid(2), timestamp: at(1),
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls", description: "List files" } }], stop_reason: "tool_use" } },
  { ...base, parentUuid: uuid(2), promptId: "p1", type: "user", uuid: uuid(3), timestamp: at(2),
    message: { role: "user", content: [{ tool_use_id: "toolu_ls", type: "tool_result", content: "", is_error: false }] } },
  { ...base, parentUuid: uuid(3), type: "assistant", uuid: uuid(4), timestamp: at(3),
    message: { role: "assistant", content: [{ type: "text", text: `Fixture Claude Code finished: ${prompt}` }], stop_reason: "end_turn" } }
]
mkdirSync(project, { recursive: true })
writeFileSync(join(project, `${session}.jsonl`), lines.map(line => `${JSON.stringify(line)}\n`).join(""))
