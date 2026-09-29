import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { commands } from "../../tui/src/editor.ts"
import { registry } from "../../tui/src/keys.ts"
import { scenarioNames } from "../scripts/scenarios.mjs"
import { collectScripts } from "../scripts/scripts.mjs"
const scripts = fileURLToPath(new URL("../../tui/docs/", import.meta.url))
const site = fileURLToPath(new URL("../../site/src/content/docs/docs/", import.meta.url))
const learn = fileURLToPath(new URL("../../site/scripts/journeys/journeys.mjs", import.meta.url))
const ids = collectScripts(scripts)
for (const script of ids.values()) {
  const setup = script.steps.find((step: { kind: string }) => step.kind === "Use")
  if (setup) assert(scenarioNames.includes(setup.value), `Unknown fixture ${setup.value}`)
}
test("every recording is a valid script and every TUI GIF on smithers.sh has one", () => {
  assert(ids.size >= 35, `Only ${ids.size} recordings`)
  const used = [...readFileSync(learn, "utf8").matchAll(/\{ id: "([a-z0-9-]+)", detail: "Production TUI/g)].map((m) => m[1]!)
  assert(used.length > 0)
  for (const id of used) assert(ids.has(id), `smithers.sh uses recording ${id}, which has no script`)
})
test("command and keyboard references on smithers.sh cover their complete runtime registries", () => {
  const commandDoc = readFileSync(join(site, "tui/commands.mdx"), "utf8")
  for (const command of [...commands, { name: "exit" }]) {
    assert(commandDoc.includes(`\`/${command.name}`), `Undocumented command ${command.name}`)
  }
  const keyDoc = readFileSync(join(site, "tui/keys.mdx"), "utf8")
  for (const binding of registry) {
    assert(keyDoc.includes(`${binding.label}.`), `Undocumented action ${binding.id}`)
    for (const key of binding.keys) assert(keyDoc.includes(`\`${key}\``), `Undocumented key ${key}`)
  }
})
