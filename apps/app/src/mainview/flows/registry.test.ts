import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { StorageApi } from "@tanstack/db"
import { describe,expect,test } from "bun:test"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { agentToolSpecs,executeAgentToolCall } from "./agentTools"
import { visibleItems } from "./Commands"
import type { CommandState } from "./registry"
import {
matches,
namespaceOf,
namespacesOf,
parseSubmit,
recommendedNames,
SLASH_MENU_CAP,
slashItems,
slashTree,
SURFACE_FLOWS
} from "./registry"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const freshController = async (bootstrap?: AppBootstrap) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableAgent, { bootstrap })
  }
}

const chatState: CommandState = {
  surface: "chat",
  typing: false,
  hasConnectors: false,
  admin: false,
  signedOut: false
}

describe("command registry pure model", () => {
  test("Wiki leads the recommendations on the conversation", () => {
    expect(recommendedNames(chatState)[0]).toBe("wiki")
    expect(recommendedNames({ ...chatState, hasConnectors: true })[0]).toBe("wiki")
    expect(recommendedNames({ ...chatState, surface: "world" })[0]).toBe("chat")
    expect(recommendedNames({ ...chatState, typing: true })).toEqual(["chat.stop"])
  })

  test("signed-out, sign-in is the only step", () => {
    expect(recommendedNames({ ...chatState, signedOut: true })).toEqual(["auth.sign-in"])
    // Typing still outranks everything.
    expect(recommendedNames({ ...chatState, signedOut: true, typing: true })).toEqual(["chat.stop"])
  })

  test("slash filtering matches name and summary, case-insensitively", () => {
    const command = { name: "wiki", summary: "Connect work to Smithers" }
    expect(matches(command, "wi")).toBe(true)
    expect(matches(command, "WORK")).toBe(true)
    expect(matches(command, "zzz")).toBe(false)
    expect(matches(command, "")).toBe(true)
  })

  test("a needle that names a flow exactly leads the listing, ahead of a summary match", () => {
    // The shape of the real defect: /flows listed flow.list first, because
    // its summary reads "List the workflows on your workspace" and it is
    // declared earlier in the registry than the flow actually named `flows`.
    const commands = [
      { name: "flow.list", summary: "List the workflows on your workspace" },
      { name: "flows", summary: "List everything Smithers can do" }
    ]
    const items = slashItems(chatState, "flows", commands)
    expect(items.map((item) => item.flow.name)).toEqual(["flows", "flow.list"])
  })

  test("a name match outranks a summary-only match, even when the summary match is recommended", () => {
    const commands = [
      // `connect` is chatState's leading recommendation, and its summary
      // happens to carry the needle. A name match still leads.
      { name: "wiki", summary: "Connect the repos you work in" },
      { name: "repos.import", summary: "Import one to the cloud" },
      { name: "repos.list", summary: "Show them" }
    ]
    expect(slashItems(chatState, "repos", commands).map((item) => item.flow.name)).toEqual([
      "repos.import",
      "repos.list",
      "wiki"
    ])
  })

  test("an exact name outranks the recommendation, which still leads a bare /", () => {
    const commands = [
      { name: "wiki", summary: "Connect work to Smithers" },
      { name: "keys", summary: "Your connected keys" }
    ]
    // connect is chatState's recommendation; naming keys beats it.
    expect(slashItems(chatState, "", commands)[0]?.flow.name).toBe("wiki")
    const named = slashItems(chatState, "keys", commands)
    expect(named[0]?.flow.name).toBe("keys")
    expect(named[0]?.recommended).toBe(false)
    // Naming the recommendation itself keeps it flagged as one.
    expect(slashItems(chatState, "wiki", commands)[0]).toEqual({
      flow: commands[0],
      recommended: true
    })
  })

  test("the exact match is never listed twice", () => {
    const commands = [
      { name: "wiki", summary: "Connect work to Smithers" },
      { name: "connectors", summary: "Manage connectors" }
    ]
    const items = slashItems(chatState, "wiki", commands)
    expect(items.map((item) => item.flow.name)).toEqual(["wiki"])
  })

  test("the slash listing puts the recommended command first", () => {
    const commands = [
      { name: "runs.list", summary: "Runs" },
      { name: "wiki", summary: "Wiki" }
    ]
    const items = slashItems(chatState, "", commands)
    expect(items[0]?.flow.name).toBe("wiki")
    expect(items[0]?.recommended).toBe(true)
    expect(items.filter((item) => item.recommended)).toHaveLength(1)
  })

  /*
   * §1.2: signed out, the listing offers only what works signed out. The
   * flows that need a session stay INVOKABLE — typing one defers through
   * sign-in (§6.2) — they are just not presented as available.
   */
  test("the signed-out listing offers nothing that needs a session", () => {
    const commands = [
      { name: "auth.sign-in", summary: "Sign in with GitHub" },
      { name: "auth.sign-out", summary: "Sign out", requires: ["signed-in"] },
      { name: "issues.create", summary: "Create an issue", requires: ["signed-in"] },
      { name: "wiki", summary: "What Smithers understands" }
    ]
    const signedOut = slashItems({ ...chatState, signedOut: true }, "", commands)
    expect(signedOut.map((item) => item.flow.name)).toEqual(["auth.sign-in", "wiki"])
    const signedIn = slashItems(chatState, "", commands)
    expect(signedIn.map((item) => item.flow.name)).toContain("issues.create")
  })

  describe("the slash menu caps at SLASH_MENU_CAP", () => {
    // 20 flows named a0..a19, all prefix-matching "a" and all containing "a".
    const many = Array.from({ length: 20 }, (_, index) => ({
      name: `a${index}`,
      summary: `Flow number ${index}`
    }))

    test("a bare / lists at most the cap, not every registered flow", () => {
      expect(many.length).toBeGreaterThan(SLASH_MENU_CAP)
      expect(slashItems(chatState, "", many).length).toBe(SLASH_MENU_CAP)
    })

    test("a prefix query is capped too — a prefix names a set, not a flow", () => {
      expect(slashItems(chatState, "a", many).length).toBe(SLASH_MENU_CAP)
    })

    test("a flow named outright is never cut", () => {
      const named = slashItems(chatState, "a19", many)
      expect(named.length).toBeLessThanOrEqual(SLASH_MENU_CAP)
      expect(named[0]?.flow.name).toBe("a19")
    })

    test("a recommendation survives the cap and still leads a bare /", () => {
      const withRecommendation = [{ name: "wiki", summary: "Connect work to Smithers" }, ...many]
      const items = slashItems(chatState, "", withRecommendation)
      expect(items.length).toBe(SLASH_MENU_CAP)
      expect(items[0]?.flow.name).toBe("wiki")
      expect(items[0]?.recommended).toBe(true)
    })

    test("recency ranks the remainder that gets in", () => {
      const recent = slashItems({ ...chatState, recent: ["a19", "a18"] }, "", many)
      expect(recent.length).toBe(SLASH_MENU_CAP)
      expect(recent.map((item) => item.flow.name)).toContain("a19")
      expect(recent.map((item) => item.flow.name)).toContain("a18")
    })
  })

  test("/wiki remains visible and the old world aliases are absent", async () => {
    const { controller } = await freshController()
    const visibleNames = visibleItems(controller.commands).map((command) => command.name)
    expect(visibleNames).toContain("wiki")
    expect(visibleNames).toContain("wiki.new-note")
    expect(visibleNames.filter((name) => name === "world" || name.startsWith("world."))).toEqual([])
    for (const name of ["world", "world.new-note", "world.select", "world.delete", "world.delete.confirm", "world.delete.cancel"]) {
      const alias = controller.commands.find(name)
      expect(alias).toBeUndefined()
    }
    const rows = controller.slashTree("wi").map((row) => (row.kind === "flow" ? row.flow.name : row.kind === "namespace" ? `${row.namespace.id}/` : row.text))
    expect(rows).toContain("wiki")
    expect(rows).toContain("wiki.new-note")
    expect(rows.some((row) => row === "world" || row.startsWith("world"))).toBe(false)
    expect(controller.slashTree("world").filter((row) => row.kind === "flow").map((row) => row.kind === "flow" ? row.flow.name : "")).toEqual([])
    expect(parseSubmit("/world", controller.commands.all())).toEqual({ kind: "unknown-command", name: "world" })
  })

  test("every visible flow lives in a namespace, except the surface switches and a repository leaf the app types", async () => {
    const { controller } = await freshController()
    // A typed entry that stands in for a repository's flow leaf keeps the leaf's bare name (`issue-sweep`).
    const orphans = visibleItems(controller.commands)
      .map((command) => command.name)
      .filter((name) => namespaceOf(name) === undefined && !SURFACE_FLOWS.includes(name) && name !== "tut" &&
        controller.commands.find(name)?.metadata.workflow !== name)
    expect(orphans).toEqual([])
  })

  test("namespaces list only where a visible flow lives, in display order", () => {
    const commands = [
      { name: "chat", summary: "" },
      { name: "tab.terminal", summary: "" },
      { name: "appearance.dark-mode", summary: "" },
      { name: "appearance.dark-mode", summary: "" },
      { name: "toast.dismiss", summary: "", hidden: true },
      { name: "zeta.one", summary: "" }
    ]
    expect(namespacesOf(commands).map((row) => [row.id, row.count])).toEqual([
      ["appearance", 2],
      ["tab", 1],
      ["zeta", 1]
    ])
    expect(namespacesOf(commands).find((row) => row.id === "appearance")?.label).toBe("Appearance")
  })

  test("a bare / is the tree's top level: recommendations, surfaces, then namespace rows", () => {
    const commands = [
      { name: "wiki", summary: "Wiki" },
      { name: "chat", summary: "Chat" },
      { name: "appearance.dark-mode", summary: "Toggle" },
      { name: "appearance.dark-mode", summary: "Theme" },
      { name: "tab.terminal", summary: "Terminal" },
      { name: "chat.filter", summary: "Filter" }
    ]
    const rows = slashTree(chatState, "", commands)
    expect(rows.map((row) => (row.kind === "flow" ? row.flow.name : row.kind === "namespace" ? `${row.namespace.id}/` : row.text))).toEqual([
      "wiki",
      "chat",
      "chat/",
      "appearance/",
      "tab/"
    ])
    expect(rows[0]?.kind === "flow" && rows[0].recommended).toBe(true)
    // No loose leaf at the top: the toggle is reachable through its namespace.
    expect(rows.some((row) => row.kind === "flow" && row.flow.name === "appearance.dark-mode")).toBe(false)
  })

  test("a namespace head with the dot lists that branch, uncapped; any other text is the flat filter", () => {
    const many = Array.from({ length: SLASH_MENU_CAP + 4 }, (_, index) => ({
      name: `tab.flow-${index}`,
      summary: `Tab flow ${index}`
    }))
    const commands = [{ name: "chat", summary: "Chat" }, { name: "appearance.dark-mode", summary: "Toggle" }, ...many]
    const branch = slashTree(chatState, "tab.", commands)
    expect(branch).toHaveLength(many.length)
    expect(branch.every((row) => row.kind === "flow" && row.flow.name.startsWith("tab."))).toBe(true)
    // Typing part of a namespace offers it as a row above the flat matches.
    const partial = slashTree(chatState, "app", commands)
    expect(partial[0]).toEqual({
      kind: "namespace",
      namespace: { id: "appearance", label: "Appearance", summary: "Light or dark mode" },
      count: 1
    })
    // A name known by heart still leads, exactly as the flat filter ranks it.
    const exact = slashTree(chatState, "appearance.dark-mode", commands)
    expect(exact[0]?.kind === "flow" && exact[0].flow.name).toBe("appearance.dark-mode")
    const fuzzy = slashTree(chatState, "dark", commands)
    expect(fuzzy.map((row) => (row.kind === "flow" ? row.flow.name : ""))).toEqual(["appearance.dark-mode"])
  })

  test("an exact bare command ranks ahead of a longer namespace prefix", () => {
    const commands = [
      { name: "tutorial.live.retry", summary: "Retry tutorial" },
      { name: "tut", summary: "Replay introduction" },
    ]
    for (const query of ["tut", "TUT"]) {
      const rows = slashTree(chatState, query, commands)
      expect(rows[0]?.kind === "flow" && rows[0].flow.name).toBe("tut")
      expect(rows[1]?.kind === "namespace" && rows[1].namespace.id).toBe("tutorial")
      expect(rows.filter(row => row.kind === "flow" && row.flow.name === "tut")).toHaveLength(1)
    }
    expect(slashTree(chatState, "tu", commands)[0]?.kind).toBe("namespace")
    expect(slashTree(chatState, "tutorial.", commands)[0]).toMatchObject({ kind: "flow", flow: { name: "tutorial.live.retry" } })
  })

  test("/flows and the data-flows manifest differ by exactly the hidden set", async () => {
    const { controller } = await freshController()
    const manifest = controller.commands.all().map((command) => command.name)
    const listed = visibleItems(controller.commands).map((command) => command.name)
    const hidden = controller.commands
      .all()
      .filter((command) => command.hidden === true)
      .map((command) => command.name)
    expect(hidden.length).toBeGreaterThan(0)
    expect(listed).toEqual(manifest.filter((name) => !hidden.includes(name)))
    expect(listed.some((name) => hidden.includes(name))).toBe(false)
  })

  test("parseSubmit resolves empty, bare command, args command, and prompt", () => {
    const commands = [
      { name: "world", summary: "w" },
      { name: "browser", summary: "b", args: "<url>", acceptsArgs: true }
    ]
    expect(parseSubmit("", commands)).toEqual({ kind: "empty" })
    expect(parseSubmit("/", commands)).toEqual({ kind: "empty" })
    expect(parseSubmit("/world", commands)).toEqual({ kind: "command", name: "world" })
    expect(parseSubmit("/browser https://example.com", commands)).toEqual({
      kind: "command",
      name: "browser",
      args: "https://example.com"
    })
    expect(parseSubmit("/world with trailing text", commands)).toEqual({
      kind: "prompt",
      text: "/world with trailing text"
    })
    expect(parseSubmit("hello there", commands)).toEqual({ kind: "prompt", text: "hello there" })
  })

  test("typed issue flows accept slash payloads without display argument hints", async () => {
    const { controller } = await freshController()
    const commands = controller.commands.all()
    for (const name of ["issue.flows", "issue.repro", "issue.poc", "issue.implement"]) {
      const command = commands.find(command => command.name === name)!
      expect(command.args).toBeUndefined()
      expect(command.acceptsArgs).toBe(true)
      expect(parseSubmit(`/${name} 3 practice:smithersai/hello-server`, commands)).toEqual({
        kind: "command", name, args: "3 practice:smithersai/hello-server"
      })
    }
    const withoutHints = commands.map(({ args: _args, ...command }) => command)
    expect(parseSubmit("/files.read README.md", withoutHints)).toEqual({
      kind: "command", name: "files.read", args: "README.md"
    })
    expect(parseSubmit("/world trailing text", commands)).toEqual({
      kind: "unknown-command", name: "world"
    })
  })

  test("display argument hints cannot grant an input capability", () => {
    expect(parseSubmit("/no-args surprise", [{ name: "no-args", summary: "No input", args: "display only", acceptsArgs: false }])).toEqual({
      kind: "prompt", text: "/no-args surprise"
    })
  })

  describe("parseSubmit command boundary", () => {
    const commands = [
      { name: "goal", summary: "Set the goal", args: "<text>", acceptsArgs: true },
      { name: "goal.show", summary: "Show the goal" },
      { name: "no-args", summary: "No arguments" }
    ]

    test.each(
      [
        ["", { kind: "empty" }],
        ["   \t\n", { kind: "empty" }],
        ["/", { kind: "empty" }],
        ["  /  ", { kind: "empty" }],
        ["/goal", { kind: "command", name: "goal" }],
        ["  /goal  ", { kind: "command", name: "goal" }],
        ["/goal.show", { kind: "command", name: "goal.show" }],
        ["/goal ship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\tship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\nship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\r\nship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\u00a0ship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal   ship it   ", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal first\nsecond", { kind: "command", name: "goal", args: "first\nsecond" }]
      ] as const
    )("parses %j", (input, expected) => {
      expect(parseSubmit(input, commands)).toEqual(expected)
    })

    test.each([
      "goal",
      "hello /goal",
      "//goal",
      "/Goal",
      "/GOAL",
      "/goal!",
      "/goal/child",
      "/goal..show",
      "/no-args surprise"
    ])("keeps %j as an agent prompt", (input) => {
      expect(parseSubmit(input, commands)).toEqual({ kind: "prompt", text: input.trim() })
    })

    /*
     * §23.5: flow SYNTAX that names no registered flow is the app's to
     * answer. Handing it to the model as prose is what made `/reset` on a
     * non-admin session run `retry`.
     */
    test.each([
      ["/unknown", "unknown"],
      ["/unknown words", "unknown"],
      ["/goal.show.more", "goal.show.more"],
      ["/reset", "reset"]
    ])("refuses %j by name instead of improvising", (input, name) => {
      expect(parseSubmit(input, commands)).toEqual({ kind: "unknown-command", name })
    })

    test("does not mutate the registry or depend on command order", () => {
      const reversed = [...commands].reverse()
      expect(parseSubmit("/goal.show", commands)).toEqual(parseSubmit("/goal.show", reversed))
      expect(commands.map((command) => command.name)).toEqual(["goal", "goal.show", "no-args"])
    })
  })
})

describe("billing plans are available to every signed-in account", () => {
  test("a non-admin session has plans, upgrade, and portal", async () => {
    const { store, controller } = await freshController()
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      admin: false,
      scopesPlain: null
    })
    const names = controller.commands.all().map((command) => command.name)
    expect(names).toContain("billing.upgrade")
    expect(names).toContain("billing.portal")
    expect(names).toContain("billing.plans")
    // The balance READ stays — knowing what you have is not a checkout.
    expect(names).toContain("billing.balance")
  })

  test("an admin session still has them, so the seam stays testable", async () => {
    const { store, controller } = await freshController()
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      admin: true,
      scopesPlain: null
    })
    const names = controller.commands.all().map((command) => command.name)
    expect(names).toContain("billing.upgrade")
    expect(names).toContain("billing.portal")
  })
})

describe("command registry bindings", () => {
  test("bootstrap capabilities are the single registration gate", async () => {
    const local = await freshController({
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "local",
      capabilities: [],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    })
    const localNames = local.controller.commands.all().map((command) => command.name)
    expect(localNames).not.toContain("auth.sign-in")
    /* Repository tracker reads require a backend capability. */
    expect(localNames).not.toContain("issues.list")
    expect(localNames).not.toContain("flow.run")
    expect(localNames).not.toContain("browser.open")

    const cloud = await freshController({
      apiVersion: 1,
      host: "cloud",
      version: "test",
      buildSha: "cloud",
      capabilities: ["agent", "identity", "cloud", "browser.read"],
      authFlow: "redirect",
      sandbox: null
    })
    const cloudNames = cloud.controller.commands.all().map((command) => command.name)
    expect(cloudNames).toContain("auth.sign-in")
    expect(cloudNames).toContain("issues.list")
    expect(cloudNames).toContain("flow.run")
    expect(cloudNames).toContain("browser.open")
    const withoutBrowser = await freshController({
      apiVersion: 1, host: "cloud", version: "test", buildSha: "cloud",
      capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null
    })
    expect(withoutBrowser.controller.commands.all().map((command) => command.name)).not.toContain("browser.open")
    expect((await withoutBrowser.controller.commands.runForAgent("browser.open", "https://example.com")).status).toBe("unavailable")
    local.controller.dispose(); cloud.controller.dispose(); withoutBrowser.controller.dispose()
  })

  /*
   * The tool schema is model-facing documentation. An example name the model
   * copies has to be a name the registry answers, or the turn spends itself on
   * an unknown-command result; the example said "browser" while the registry
   * only ever declared "browser.open".
   */
  test("every example command name in the model tool schema is a registered flow", async () => {
    const { controller } = await freshController()
    const registered = new Set(controller.commands.all().map((command) => command.name))
    const strings = (value: unknown): ReadonlyArray<string> =>
      typeof value === "string"
        ? [value]
        : typeof value === "object" && value !== null
        ? Object.values(value as Record<string, unknown>).flatMap(strings)
        : []
    const examples = agentToolSpecs
      .flatMap((spec) => strings(spec))
      .flatMap((text) => [...text.matchAll(/e\.g\. "([^"]+)"/g)])
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined)
    expect(examples.length).toBeGreaterThan(0)
    expect(examples.filter((example) => !registered.has(example.replace(/^\//, "")))).toEqual([])
    controller.dispose()
  })

  test("admin commands are ABSENT for a non-admin session, present for an admin", async () => {
    const { store, controller } = await freshController()
    const names = controller.commands.all().map((command) => command.name)
    // Not hidden — absent. A non-admin session's enumeration surface has no trace.
    expect(names.some((name) => name.startsWith("admin."))).toBe(false)
    expect((await controller.commands.run("admin.health")).status).toBe("unknown-command")
    // The reset affordance is admin-only too (§2): /admin.reset for a
    // non-admin renders the same unknown-command state as any typo.
    expect(names).not.toContain("admin.reset")
    expect((await controller.commands.run("admin.reset")).status).toBe("unknown-command")
    expect(controller.slashItems("admin.reset")).toHaveLength(0)
    // The agent tool's list carries no trace either.
    const listed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    expect(listed).not.toContain("admin.")
    expect(listed).not.toContain("admin.reset")

    // Flip the session to admin (as a validated identity.session.loaded would).
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      admin: true,
      scopesPlain: null
    })
    const adminNames = controller.commands.all().map((command) => command.name)
    expect(adminNames).not.toContain("admin.grant")
    // The closed-alpha gate retired with its operator doors (#2145).
    for (const retired of ["admin.allowlist.add", "admin.allowlist.remove", "admin.requests", "admin.queue.approve", "auth.request-access"]) {
      expect(adminNames).not.toContain(retired)
    }
    expect(adminNames).not.toContain("admin.health")
    expect(adminNames).toContain("admin.reset")
    expect(adminNames).toContain("admin.reset.ask")
    expect(adminNames).toContain("admin.reset.cancel")
    expect(adminNames).toContain("admin.devtools")
    expect((await controller.commands.run("admin.reset.ask")).status).toBe("executed")
    expect(store.session().resetConfirmOpen).toBe(true)
    expect((await controller.commands.run("admin.reset.cancel")).status).toBe("executed")
    expect(store.session().resetConfirmOpen).toBe(false)
    // The debug reads compose the admin-only registry + trigger axis.
    expect(adminNames).toContain("debug.snapshot")
    expect(adminNames).toContain("debug.events")
    expect(adminNames).toContain("debug.seams")
  })

  test("the trigger axis: user-only commands are invisible to and uncallable by the agent", async () => {
    const { controller } = await freshController()
    const listed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    const parsed = JSON.parse(listed) as { commands: Array<{ name: string }> }
    const agentNames = parsed.commands.map((command) => command.name)
    // Browser mechanics never appear in the agent's tool catalog.
    for (
      const userOnly of [
        "chat.stop",
        "chat.send",
        "card.maximize"
      ]
    ) {
      expect(agentNames).not.toContain(userOnly)
    }
    expect(agentNames).toContain("wiki")
    expect(agentNames).toContain("browser.open")

    // Asking for one anyway gets an honest tool-result error naming the
    // visible alternative — never a silent refusal, never an execution.
    const signIn = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "chat.send" })
    })
    expect(signIn).toContain("user-only")
    expect(signIn).toContain("answer with text instead")

    // Every listed flow is a tool call (flows/invocable.test.ts pins the invariant).
    const theme = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "appearance.dark-mode" })
    })
    expect(theme).toBe("executed /appearance.dark-mode")

    // The user-only guard never leaks into the user path: the human's own
    // invocation still executes.
    expect((await controller.commands.run("appearance.dark-mode")).status).toBe("executed")
  })

  test("a bare /name typed into the composer runs the command, not a prompt", async () => {
    const { store, controller } = await freshController()
    controller.changeDraft("/wiki")
    controller.send(store.session().draft)
    const deadline = Date.now() + 2_000
    while (!store.collections.cards.has("world-embedded") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(store.collections.cards.get("world-embedded")?.kind).toBe("world")
    expect(store.session().surface).toBe("chat")
    expect(store.session().draft).toBe("")
    expect([...store.collections.messages.values()].some((m) => m.text === "/wiki")).toBe(false)
  })

  test("slashItems surfaces the recommended command first for a bare /", async () => {
    const { controller } = await freshController()
    const items = controller.slashItems("")
    expect(items[0]?.flow.name).toBe("wiki")
    expect(items[0]?.recommended).toBe(true)
  })

  /*
   * The registered catalog, not a fixture: typing a whole flow name and
   * pressing Enter runs THAT flow. The composer's Enter takes the first item
   * of this listing, so first-ness is the whole contract. Every registered
   * name is checked, because the defect this pins was one name whose text
   * happened to appear inside another flow's summary.
   */
  test("every registered flow leads its own name's listing", async () => {
    const { controller } = await freshController()
    const listed = controller.commands.all().filter((command) => command.hidden !== true)
    // Not a vacuous pass: the whole registered catalog is under test.
    expect(listed.length).toBeGreaterThan(40)
    const misdirected = listed
      .map((command) => ({ typed: command.name, leads: controller.slashItems(command.name)[0]?.flow.name }))
      .filter((row) => row.leads !== row.typed)
    expect(misdirected).toEqual([])
  })

  test("the agent tool lists commands and executes them through the same path", async () => {
    const { controller } = await freshController()
    const listed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    const parsed = JSON.parse(listed) as {
      state: { surface: string }
      commands: Array<{ name: string }>
    }
    expect(parsed.state.surface).toBe("chat")
    expect(parsed.commands.some((command) => command.name === "wiki")).toBe(true)
    expect(parsed.commands.some((command) => command.name === "connector.remove")).toBe(false)

    const executed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "wiki" })
    })
    expect(executed).toBe("executed /wiki")

    // The recovery is in the error: the dead-end "unknown-command: nope"
    // left the live model telling the USER to run the command instead of
    // retrying with a listed name in the same turn.
    const unknown = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "nope" })
    })
    expect(unknown).toBe(
      "unknown-command: nope — no command has that name; use the list action for every command callable right now"
    )
  })

  test("the model may spell a command the way the catalog does — /name resolves to name", async () => {
    /*
     * The generated capability section spells every command "/name", and
     * live on canary the model echoed that spelling into the tool call:
     * execute {"name":"/browser"} died as unknown-command and the turn
     * degraded into asking permission for the act it had been asked to do.
     * The agent boundary strips the catalog's slash exactly as the
     * composer's parseSubmit strips the human's; the registry's names stay
     * bare.
     */
    const { store, controller } = await freshController()
    const executed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/wiki" })
    })
    expect(executed).toBe("executed /wiki")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("world-embedded")?.kind).toBe("world")

    // The slash spelling resolves through the alias and executes now that the
    // look-and-feel flows are model-invocable (flows/invocable.test.ts).
    const theme = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/appearance.dark-mode" })
    })
    expect(theme).toBe("executed /appearance.dark-mode")

    // A bare "/" names nothing.
    const empty = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/" })
    })
    expect(empty).toBe("failed: the execute action requires a command name")
  })
})


test("Library is absent by default from commands, recommendations and agent tools", async () => {
  const { store, controller } = await freshController()
  expect(Object.keys(controller.features)).not.toContain("pluginLibrary")
  for (const name of ["plugins", "plugins.list", "plugins.install", "plugins.remove"]) {
    expect(controller.commands.find(name)).toBeUndefined()
    expect((await controller.commands.run(name, "librarian")).status).not.toBe("executed")
  }
  expect(recommendedNames(chatState)).not.toContain("plugins")
  expect(controller.commands.callable().map(entry => entry.binding.descriptor.name)).not.toContain("plugins.install")
  expect(store.session().plugins ?? []).toEqual([])
  await controller.dispose()
})
