import { describe, expect, test } from "bun:test"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { SMITHERS_INSTRUCTIONS } from "./Instructions"
import { json, memoryStorage, settled, unavailableAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * A discarded failure does not just hide from the user — it makes the MODEL
 * claim success. Asked to stop the response, the model answered "Okay, I've
 * stopped." while its tool call had failed; asked for its balance it answered
 * "$0.00" one line above a card its own call had rendered reading "$519 left"
 * (§22.7). Both halves are pinned here: what the tool boundary hands back, and
 * what the runtime context states before the model ever calls anything.
 */

const BALANCE = {
  user: "codeplanesmithers",
  balance: { totalUsd: "519", totalNanos: 0, lifetimeChargedUsd: "0", chargeCount: 1722 },
  state: "ok",
  allowedToStartWork: true,
  credits: []
}

const backend = (): AppServices => ({
  fetchImpl: async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url, "https://app.test").pathname
    if (path === "/api/billing/balance") return json(200, BALANCE)
    if (path === "/api/repos/will/nope/issues/99") return json(404, { message: "issue not found" })
    return json(404, { message: `no stub for ${path}` })
  }
})

/* Hosted (Plue) only: the Mac install registers no billing flow (mvp.md M-09). */
const hostedBalance: AppServices["bootstrap"] = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null,
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false, balance: true }) }

const ready = async (services: Partial<AppServices> = {}): Promise<{ store: AppStore; controller: ReturnType<typeof createAppController> }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, { ...backend(), ...services })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    admin: false,
    scopesPlain: null
  })
  await settled()
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: ["codeplanesmithers/canary-sandbox", "codeplanesmithers/demo-calendar"].map((fullName) => ({
      id: fullName,
      org: fullName.split("/")[0] ?? "",
      ownerKind: "user",
      name: fullName.split("/")[1] ?? "",
      head: null
    }))
  })
  await settled()
  return { store, controller }
}

const execute = (
  controller: ReturnType<typeof createAppController>,
  name: string,
  args?: string
): Promise<string> =>
  controller.commands.executeForAgent({
    name: "commands",
    arguments: JSON.stringify({ action: "execute", name, ...(args === undefined ? {} : { args }) })
  })

describe("a failed flow reaches the model as a failure", () => {
  test("a user-only flow the model asks for answers failed, never a bare acknowledgement", async () => {
    const { controller } = await ready()
    const result = await execute(controller, "stop")
    expect(result).toStartWith("failed:")
    expect(result).toContain("user-only")
  })

  test("a seam refusal reaches the model verbatim, prefixed failed", async () => {
    const { controller } = await ready()
    const result = await execute(controller, "issues.view", "99 will/nope")
    expect(result).toStartWith("failed:")
    expect(result).toContain("99")
  })

  test("a malformed argument reaches the model as a failure, not as a run", async () => {
    const { controller } = await ready()
    const result = await execute(controller, "env.set", "NOT_AN_ASSIGNMENT will/nope")
    expect(result).toStartWith("failed:")
    expect(result).toContain("NAME=value")
  })

  test("a name that is not registered says nothing ran", async () => {
    const { controller } = await ready()
    expect(await execute(controller, "no-such-flow")).toStartWith("unknown-command:")
  })

  /*
   * The instruction half: the plumbing has always handed back `failed:`, and
   * the model still wrote "Okay, I've stopped." over it. The rule that a
   * `failed:` result means the act did not happen is now stated outright.
   */
  test("the instructions state that a failed result means the act did not happen", () => {
    expect(SMITHERS_INSTRUCTIONS).toContain("\"failed:\" means the act DID NOT HAPPEN")
    expect(SMITHERS_INSTRUCTIONS).toContain("\"unknown-command:\"")
  })
})

describe("the model is told the numbers it is asked about", () => {
  test("hosted billing.balance hands the figure back instead of void", async () => {
    const { controller } = await ready({ bootstrap: hostedBalance })
    const result = await execute(controller, "billing.balance")
    expect(result).not.toStartWith("failed:")
    expect(result).toContain("$519")
    expect(result).toContain("1722")
  })

  test("the runtime context carries the balance, and the repositories BY NAME, before any tool call", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(
      store,
      {
        available: true,
        startTurn: async (request) => {
          requests.push(request)
          return { status: "error", message: "Recorded." }
        },
        cancelTurn: async () => {},
        subscribe: () => () => {}
      },
      {
        ...backend(),
        bootstrap: hostedBalance
      }
    )
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      admin: false,
      scopesPlain: null
    })
    await settled()
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: ["codeplanesmithers/canary-sandbox", "codeplanesmithers/demo-calendar"].map((fullName) => ({
        id: fullName,
        org: fullName.split("/")[0] ?? "",
        ownerKind: "user",
        name: fullName.split("/")[1] ?? "",
        head: null
      }))
    })
    await settled()
    await controller.refreshBalance()
    await settled()

    controller.send("what is my balance right now?")
    await settled()
    const context = requests[0]?.context as AgentRuntimeContext | undefined
    expect(context?.billing?.totalUsd).toBe("519")
    expect(context?.billing?.state).toBe("ok")
    expect(context?.github.repositories).toBe(2)
    expect(context?.github.repositoryNames).toEqual([
      "codeplanesmithers/canary-sandbox",
      "codeplanesmithers/demo-calendar"
    ])
  })

  test("a hosted billing service that did not answer states that, and names no figure", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent, {
      bootstrap: hostedBalance,
      fetchImpl: async () => json(500, { message: "billing is down" })
    })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      admin: false,
      scopesPlain: null
    })
    await settled()
    const result = await execute(controller, "billing.balance")
    expect(result).toStartWith("failed:")
    expect(result).not.toContain("$")
  })
})
