/*
 * The list action is the model's only discovery channel once the prompt
 * degrades to stage 3 (namespaces and counts only). Both tool loops bound every
 * tool result at MAX_TOOL_RESULT_BYTES, and the full registry rendered with
 * `acceptsArgs` + `args` measured 20 to 23 KiB: the model got a 16 KiB prefix
 * that did not parse and lost every search.*, repo.*, target.* name. This pins
 * the list against the REAL registry on both hosts, through the bound.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { agentVisibleCatalog, executeAgentToolCall } from "./agentTools"
import type { AgentToolCall } from "./agentTools"
import type { CommandState } from "./registry"
import { boundToolResult, MAX_TOOL_RESULT_BYTES, utf8Bytes } from "../state/AgentTurnPolicy"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "../state/ControllerTestScope"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, settled, signupProfileFetch, waitFor } from "../state/TestFixtures"
import { SIGNUP_PROFILE_PATH } from "../state/Signup"

const createAppController = scopedControllers()
const externalWork: Array<{
  controller: ReturnType<typeof createAppController>
  requests: string[]
  profileReads: string[]
  starts: StartAgentTurnRequest[]
  cancellations: string[]
}> = []

afterEach(async () => {
  const failures: unknown[] = []
  for (const fixture of externalWork.splice(0)) {
    // Check after disposal as well: a caught request is still unexpected work.
    try { await fixture.controller.dispose() } catch (error) { failures.push(error) }
    for (const work of [fixture.requests, fixture.starts, fixture.cancellations]) {
      try { expect(work).toEqual([]) } catch (error) { failures.push(error) }
    }
    try { expect(fixture.profileReads).toEqual([SIGNUP_PROFILE_PATH]) } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Discovery fixture cleanup failed")
})

const bootstraps: ReadonlyArray<AppBootstrap> = [
  {
    apiVersion: 1,
    host: "cloud",
    version: "test",
    buildSha: "cloud",
    capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true, browser: true }),
    authFlow: "redirect",
    sandbox: null
  },
  {
    apiVersion: 1,
    host: "local",
    version: "test",
    buildSha: "local",
    capabilities: localCapabilities({ agent: true, identity: true, cloud: true, browser: true }),
    authFlow: "native-handoff",
    sandbox: { platform: "darwin", mode: "enforced" }
  }
]

interface ListResult {
  state: CommandState
  note?: string
  commands: Array<{ name: string; summary?: string; args?: string }>
}

const harness = async (bootstrap: AppBootstrap = bootstraps[0]!) => {
  const starts: StartAgentTurnRequest[] = []
  const cancellations: string[] = []
  const requests: string[] = []
  // Agent execution is an external seam. Discovery must never ask it to work.
  const agent: AgentPort = {
    available: true,
    startTurn: async request => {
      starts.push(request)
      return { status: "error", message: "Unexpected agent turn during discovery" }
    },
    cancelTurn: async runId => { cancellations.push(runId) },
    subscribe: () => () => {}
  }
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const disposeStore = store.dispose
  if (disposeStore === undefined) throw new Error("Discovery fixture requires store disposal")
  const settleStore = store.settled
  if (settleStore === undefined) {
    await disposeStore()
    throw new Error("Discovery fixture requires store settlement")
  }
  let controller: ReturnType<typeof createAppController>
  const profile = signupProfileFetch(async input => {
    requests.push(String(input))
    throw new Error(`Unexpected HTTP request during discovery: ${String(input)}`)
  })
  try {
    controller = createAppController(store, agent, {
      bootstrap,
      fetchImpl: profile.fetchImpl
    })
  } catch (error) {
    await disposeStore()
    throw error
  }
  externalWork.push({ controller, requests, profileReads: profile.reads, starts, cancellations })
  // Once constructed, the scoped controller owns store disposal too.
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  await waitFor(() => profile.reads.length === 1)
  await settled()
  const read = async (call: AgentToolCall): Promise<string> => {
    await settleStore()
    const before = await store.eventHistory()
    const result = await executeAgentToolCall(controller.commands, call)
    await settleStore()
    expect(await store.eventHistory()).toEqual(before)
    expect(starts).toEqual([])
    expect(cancellations).toEqual([])
    expect(requests).toEqual([])
    expect(profile.reads).toEqual([SIGNUP_PROFILE_PATH])
    return result
  }
  const list = async (namespace?: unknown): Promise<ListResult> => {
    const raw = await read({ name: "commands", arguments: JSON.stringify({ action: "list", ...(namespace === undefined ? {} : { namespace }) }) })
    expect(utf8Bytes(raw)).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES)
    const bounded = boundToolResult(raw)
    expect(bounded.truncated).toBe(false)
    const parsed = JSON.parse(bounded.modelOutput) as ListResult
    expect(parsed.state).toEqual(controller.commands.state())
    return parsed
  }
  return { store, controller, read, list }
}

describe("the commands list action", () => {
  test.each([...bootstraps])("every callable command survives the tool-result bound on the $host host", async (bootstrap: AppBootstrap) => {
    const { controller, list } = await harness(bootstrap)
    const parsed = await list()
    const expected = agentVisibleCatalog(controller.commands.callable()).map((command) => command.name)
    const names = parsed.commands.map(command => command.name)
    expect(expected.length).toBeGreaterThan(100)
    expect(names).toEqual(expected)
    expect(new Set(names).size).toBe(names.length)
    for (const name of ["auth.prompt", "search.open", "repo.overview", "repo.update", "chat.clear"]) expect(names).toContain(name)
    for (const name of ["auth.sign-in", "palette.open", "chat.send", "repo.select"]) {
      expect(controller.commands.find(name)).toBeDefined()
      expect(names).not.toContain(name)
    }
    /*
     * The ladder's contract, not one of its rungs: a command keeps its summary
     * unless the result SAYS the summaries went, and then it says how to get
     * them back. The cloud catalog crossed that threshold when `flow.plan`
     * stopped being a flagged door (D-080) — 200 commands render at 16279
     * bytes plus the note, against a 16384-byte bound — so the remedy below
     * is the half a model actually depends on there.
     */
    if (parsed.note === undefined) {
      for (const command of parsed.commands) expect(typeof command.summary).toBe("string")
    } else {
      expect(parsed.note).toContain("list one namespace")
    }
    // One namespace always carries its summaries and its args (the full list may have shed them to fit).
    const scoped = await list("/repo")
    expect(scoped.note).toBeUndefined()
    expect(scoped.commands.length).toBeGreaterThan(0)
    expect(scoped.commands.every((command) => command.name.startsWith("repo."))).toBe(true)
    expect(scoped.commands.map((command) => command.name)).toEqual(expected.filter((name) => name.startsWith("repo.")))
    expect(scoped.commands.some((command) => command.args !== undefined)).toBe(true)
    for (const command of scoped.commands) expect(typeof command.summary).toBe("string")
  })

  test.each([
    { namespace: "repo", prefix: "repo." },
    { namespace: "/repo", prefix: "repo." },
    { namespace: "repo.", prefix: "repo." },
    { namespace: "/repo.", prefix: "repo." },
    { namespace: "repo.overview", exact: "repo.overview" },
    { namespace: "missing.namespace", exact: "missing.namespace" }
  ])("namespace $namespace returns exactly its disclosed entries", async ({ namespace, prefix, exact }) => {
    const { controller, list } = await harness()
    const catalog = agentVisibleCatalog(controller.commands.callable())
    const scoped = await list(namespace)
    const expected = catalog.filter(command => prefix === undefined ? command.name === exact : command.name.startsWith(prefix))
    expect(scoped).toEqual({ state: controller.commands.state(), commands: expected })
    if (prefix !== undefined) {
      expect(catalog.some(command => command.name.startsWith("repos.") || command.name.startsWith("repository."))).toBe(true)
      expect(scoped.commands.map(command => command.name)).toContain("repo.overview")
      expect(scoped.commands.some(command => command.name.startsWith("repos.") || command.name.startsWith("repository."))).toBe(false)
    } else {
      expect(scoped.commands.length).toBe(exact === "repo.overview" ? 1 : 0)
    }
  })

  test("empty and non-string namespaces return the unchanged full list", async () => {
    const { list } = await harness()
    const full = await list()
    for (const namespace of ["", "/", null, 0, false, {}, []]) expect(await list(namespace)).toEqual(full)
  })

  test("list samples the current committed state on each call", async () => {
    const { store, list } = await harness()
    const before = await list("repo.overview")
    expect(before.state.surface).toBe("chat")
    await store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }).isPersisted.promise
    const after = await list("repo.overview")
    expect(after.state.surface).toBe("world")
    expect(after.commands).toEqual(before.commands)
  })

  test.each([
    { label: "unknown tool", name: "other", arguments: "not JSON", expected: "unknown-tool: other" },
    { label: "malformed JSON", arguments: "{", expected: "failed: the commands tool arguments were not valid JSON" },
    ...["null", "[]", '"list"', "0", "true"].map(argumentsText => ({ label: `non-object ${argumentsText}`, arguments: argumentsText, expected: "failed: the commands tool arguments must be an object" })),
    { label: "missing action", arguments: "{}", expected: 'failed: the commands tool action must be "list" or "execute"' },
    { label: "wrong action", arguments: '{"action":"LIST","name":"chat.clear"}', expected: 'failed: the commands tool action must be "list" or "execute"' },
    { label: "non-string action", arguments: '{"action":[],"name":"chat.clear"}', expected: 'failed: the commands tool action must be "list" or "execute"' }
  ])("rejects $label without executing a command", async ({ name, arguments: argumentsText, expected }: { name?: string; arguments: string; expected: string }) => {
    const { read } = await harness()
    expect(await read({ name: name ?? "commands", arguments: argumentsText })).toBe(expected)
  })
})
