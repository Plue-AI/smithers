// Install as agent-terminal-fixture.mjs in the scratch repository before C-J3-10.
// package.json: { "scripts": { "test": "node agent-terminal-fixture.mjs" } }
if (process.getuid() !== 19999) throw new Error("Agent terminal must run as uid 19999")
process.stdout.write("AGENT_TERMINAL_UID=19999\n")
process.stdout.write("\x1b[32mAGENT_TERMINAL_FIRST\x1b[0m\n")
setTimeout(() => {
  process.stdout.write("AGENT_TERMINAL_LAST", () => { process.exitCode = 7 })
}, 8000)
