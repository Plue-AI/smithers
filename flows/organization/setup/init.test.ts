import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { parse } from "yaml"
import { command, init } from "./init.ts"
import type { Io } from "./settings.ts"
import { slackBotEvents, slackBotScopes } from "./templates.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-init-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const capture = (env: Io["env"] = {}) => {
  const out: Array<string> = [], err: Array<string> = []
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line), env, cwd: scratch },
    out,
    err
  }
}

test("init copies the example, writes the templates, and seeds a private .env", async () => {
  const dir = join(scratch, "fresh"), stateDir = join(scratch, "fresh-state")
  const result = await init({ dir, stateDir, appName: "Smithers Org" })
  assert.equal(result.created, true)
  assert.ok(existsSync(join(dir, "Org", "Roles", "assistant.md")))
  const example = readFileSync(join(dir, "Org", "Setup", ".env.example"), "utf8")
  for (
    const name of [
      "SMITHERS_ORG_AUTH=subscription",
      "# ChatGPT: sign in once with `codex login`",
      "SMITHERS_SLACK_BOT_TOKEN=",
      "SMITHERS_SLACK_APP_TOKEN=",
      "SMITHERS_SLACK_TEAM_IDS=",
      "SMITHERS_SLACK_USER_IDS=",
      "# SMITHERS_SLACK_CHANNEL_IDS=",
      "# SMITHERS_SLACK_TEAM_CHANNEL=smithers-team",
      "# name=path; the roster grants example/demo",
      "SMITHERS_ORG_REPOS=",
      `SMITHERS_ORG_ROOT=${dir}`,
      `SMITHERS_ORG_STATE_DIR=${stateDir}`,
      "# SMITHERS_ORG_MAX_CONCURRENT_VMS=2"
    ]
  ) {
    assert.ok(example.split("\n").includes(name), name)
  }
  // Seats run on subscriptions: no API key is asked for.
  assert.doesNotMatch(example, /API_KEY/)
  // Every other variable is a name with an empty value or a local path; no secret is invented.
  for (
    const line of example.split("\n").filter((line) => /^[A-Z_]+=/.test(line) && !line.startsWith("SMITHERS_ORG_AUTH="))
  ) {
    assert.match(line, /^[A-Z_]+=(|\/.*)$/)
  }
  assert.equal(readFileSync(join(stateDir, ".env"), "utf8"), example)
  assert.equal(statSync(join(stateDir, ".env")).mode & 0o777, 0o600)
  assert.equal(statSync(stateDir).mode & 0o777, 0o700)
})

test("the manifest is one Socket Mode app with the Slack guide's scopes, events, interactivity and App Home messages", async () => {
  const dir = join(scratch, "manifest")
  await init({ dir, stateDir: join(scratch, "manifest-state"), appName: "Acme Org" })
  const manifest = parse(readFileSync(join(dir, "Org", "Setup", "slack-app-manifest.yaml"), "utf8"))
  assert.equal(manifest.display_information.name, "Acme Org")
  assert.deepEqual([...manifest.oauth_config.scopes.bot].sort(), [
    "app_mentions:read",
    "channels:history",
    "channels:join",
    "channels:manage",
    "channels:read",
    "chat:write",
    "chat:write.customize",
    "chat:write.public",
    "im:history",
    "im:read",
    "im:write",
    "reactions:read",
    "reactions:write",
    "users:read"
  ])
  assert.deepEqual(manifest.oauth_config.scopes.bot, [...slackBotScopes])
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, [...slackBotEvents])
  assert.equal(manifest.settings.event_subscriptions.request_url, undefined)
  assert.equal(manifest.settings.socket_mode_enabled, true)
  assert.equal(manifest.settings.interactivity.is_enabled, true)
  assert.equal(manifest.features.app_home.messages_tab_enabled, true)
  assert.equal(manifest.features.app_home.messages_tab_read_only_enabled, false)
  await assert.rejects(init({ dir: join(scratch, "bad-name"), stateDir: join(scratch, "bad-state"), appName: "a: b" }))
})

test("init validates an existing Org, keeps its files and an existing .env", async () => {
  const dir = join(scratch, "existing"), stateDir = join(scratch, "existing-state")
  await init({ dir, stateDir, appName: "Smithers Org" })
  const role = join(dir, "Org", "Organization.md")
  writeFileSync(role, readFileSync(role, "utf8") + "\nOwner note.\n")
  writeFileSync(join(stateDir, ".env"), "OPENAI_API_KEY=kept\n")
  const second = await init({ dir, stateDir, appName: "Smithers Org" })
  assert.equal(second.created, false)
  assert.match(readFileSync(role, "utf8"), /Owner note\./)
  assert.equal(readFileSync(join(stateDir, ".env"), "utf8"), "OPENAI_API_KEY=kept\n")
  assert.ok(!second.files.includes(join(stateDir, ".env")))
})

test("the command refuses an invalid Org with the loader's reasons and writes no template", async () => {
  const dir = join(scratch, "invalid"), stateDir = join(scratch, "invalid-state")
  await init({ dir, stateDir, appName: "Smithers Org" })
  rmSync(join(dir, "Org", "Setup"), { recursive: true })
  const page = join(dir, "Org", "Organization.md")
  writeFileSync(page, readFileSync(page, "utf8").replace("owner: owner", "owner: someone"))
  const { io, err } = capture()
  assert.equal(await command.run([dir, "--state-dir", stateDir], io), 1)
  assert.match(err[0]!, /^invalid/)
  assert.match(err.join("\n"), /Org\/Organization\.md/)
  assert.ok(!existsSync(join(dir, "Org", "Setup")))
})

test("the command resolves a relative dir, reads the state dir from the environment, and rejects bad usage", async () => {
  const stateDir = join(scratch, "env-state")
  const { io, out } = capture({ SMITHERS_ORG_STATE_DIR: stateDir })
  assert.equal(await command.run(["relative"], io), 0)
  assert.ok(existsSync(join(scratch, "relative", "Org", "Organization.md")))
  assert.ok(existsSync(join(stateDir, ".env")))
  assert.match(out.at(-1)!, /doctor --root/)
  const usage = capture()
  assert.equal(await command.run([], usage.io), 2)
  assert.match(usage.err[0]!, /^usage: init/)
})
