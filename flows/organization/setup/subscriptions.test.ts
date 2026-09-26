import { Effect } from "effect"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import * as RequestExecutor from "../../../packages/smithers/agent/model/src/RequestExecutor.ts"
import * as Subscriptions from "./subscriptions.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-subscriptions-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const executor = RequestExecutor.RequestExecutor.of({ execute: () => Effect.die("no model is called") })
const codexHome = join(scratch, "codex")
mkdirSync(codexHome)
writeFileSync(join(codexHome, "auth.json"), "{}\n")

/** What resolving a seat says: its model id, or the refusal's message. */
const resolves = (resolver: ReturnType<typeof Subscriptions.resolver>, seat: string) =>
  Effect.runPromise(
    resolver.resolve(seat).pipe(
      Effect.map((resolved) => `resolved ${resolved.modelId}`),
      Effect.catch((error) => Effect.succeed(error.message))
    )
  )

const login = (claudeAiOauth: unknown) => () => ({ text: JSON.stringify({ claudeAiOauth }), source: "fixture store" })

test("the mode defaults to subscription and refuses anything but the two names", () => {
  assert.equal(Subscriptions.modeOf({}), "subscription")
  assert.equal(Subscriptions.modeOf({ SMITHERS_ORG_AUTH: " subscription " }), "subscription")
  assert.equal(Subscriptions.modeOf({ SMITHERS_ORG_AUTH: "api-key" }), "api-key")
  assert.throws(() => Subscriptions.modeOf({ SMITHERS_ORG_AUTH: "keys" }), /must be "subscription" or "api-key"/)
})

test("subscription mode removes API keys and selects the ChatGPT login; api-key mode changes nothing", () => {
  const env = { OPENAI_API_KEY: "sk-stale", ANTHROPIC_API_KEY: "sk-ant-stale", PATH: "/bin" }
  assert.deepEqual(Subscriptions.seatEnvironment(env), { PATH: "/bin", SMITHERS_OPENAI_AUTH: "chatgpt" })
  const keyed = { ...env, SMITHERS_ORG_AUTH: "api-key" }
  assert.equal(Subscriptions.seatEnvironment(keyed), keyed)
  assert.equal(Subscriptions.providerOf("openai:gpt-6-sol"), "openai")
  assert.equal(Subscriptions.providerOf("claude-sonnet-5"), "anthropic")
  assert.equal(Subscriptions.chatgptLogin({ CODEX_HOME: codexHome }), join(codexHome, "auth.json"))
})

test("openai seats run on the ChatGPT login and never on a stale key", async () => {
  const env = { CODEX_HOME: codexHome, OPENAI_API_KEY: "sk-stale" }
  assert.equal(await resolves(Subscriptions.resolver(env, executor), "openai:gpt-6-sol"), "resolved gpt-6-sol")
  const signedOut = Subscriptions.resolver({ ...env, CODEX_HOME: join(scratch, "none") }, executor)
  assert.match(await resolves(signedOut, "openai:gpt-6-sol"), /codex login/)
})

test("Anthropic seats run on a subscription token, else on the Claude Code login read at resolution", async () => {
  const now = () => 1_000
  const seat = "anthropic:claude-sonnet-5"
  const reads: Array<string> = []
  const counted = (claudeAiOauth: unknown) => () => {
    reads.push("read")
    return login(claudeAiOauth)()
  }
  // A token wins, and the stored login is never read.
  const tokened = Subscriptions.resolver(
    { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-token", ANTHROPIC_API_KEY: "sk-ant-stale" },
    executor,
    {
      credentials: counted({ accessToken: "unused" }),
      now
    }
  )
  assert.equal(await resolves(tokened, seat), "resolved claude-sonnet-5")
  assert.deepEqual(reads, [])

  const signedIn = Subscriptions.resolver({ ANTHROPIC_API_KEY: "sk-ant-stale" }, executor, {
    credentials: counted({ accessToken: "sk-ant-oat-login", expiresAt: 2_000 }),
    now
  })
  assert.equal(await resolves(signedIn, seat), "resolved claude-sonnet-5")
  assert.equal(await resolves(signedIn, seat), "resolved claude-sonnet-5")
  assert.deepEqual(reads, ["read", "read"])

  const noExpiry = Subscriptions.resolver({}, executor, {
    credentials: login({ accessToken: "sk-ant-oat-login" }),
    now
  })
  assert.equal(await resolves(noExpiry, seat), "resolved claude-sonnet-5")

  const expired = Subscriptions.resolver({}, executor, {
    credentials: login({ accessToken: "sk-ant-oat-login", expiresAt: 1_000 }),
    now
  })
  const message = await resolves(expired, seat)
  assert.match(message, /The Claude Code login in fixture store expired at 1970-01-01T00:00:01\.000Z/)
  assert.doesNotMatch(message, /sk-ant/)

  for (
    const credentials of [
      () => undefined,
      login({}),
      login({ accessToken: "" }),
      () => ({ text: "{not json", source: "x" })
    ]
  ) {
    const missing = Subscriptions.resolver({}, executor, { credentials, now })
    assert.match(await resolves(missing, seat), /Sign in to Claude Code \(`claude`\), or set CLAUDE_CODE_OAUTH_TOKEN/)
  }

  // api-key mode reads keys as the native resolver does.
  const keyed = Subscriptions.resolver({ SMITHERS_ORG_AUTH: "api-key" }, executor, {
    credentials: login({ accessToken: "x" }),
    now
  })
  assert.match(await resolves(keyed, seat), /ANTHROPIC_API_KEY/)
})

test("the Claude Code store is its config directory's credentials file", () => {
  const configDir = join(scratch, "claude")
  mkdirSync(configDir)
  const read = Subscriptions.claudeCredentials({ CLAUDE_CONFIG_DIR: configDir })
  if (process.platform !== "darwin") assert.equal(read(), undefined)
  writeFileSync(
    join(configDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-file", expiresAt: 5 } })
  )
  assert.deepEqual(Subscriptions.claudeLogin(read), {
    accessToken: "sk-ant-oat-file",
    expiresAt: 5,
    source: join(configDir, ".credentials.json")
  })
})
