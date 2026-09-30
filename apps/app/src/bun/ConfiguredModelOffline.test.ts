import { expect,test } from "bun:test"
import { mkdtemp,rm,writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { PROVIDER_MODEL,PROVIDER_REPLY } from "../../e2e/real/support/model-provider-behaviors"
import { launchModelProvider } from "../../e2e/real/support/model-provider-process"
import { createRuntime,loadBootstrap,unavailableAgent } from "../mainview/runtime/Runtime"
import { createAppStore } from "../mainview/state/AppStore"
import { scopedControllers } from "../mainview/state/ControllerTestScope"
import { memoryStorage, waitFor } from "../mainview/state/TestFixtures"
import { startLocalServer } from "./server"

const createAppController = scopedControllers()

test("an offline host tests and assigns a loopback model, then answers through the bootstrapped transport", async () => {
  const key = "sk-offline-0123456789abcdef"
  const provider = await launchModelProvider({ key })
  const root = await mkdtemp(join(tmpdir(), "smithers-model-offline-"))
  await writeFile(join(root, "index.html"), "<!doctype html><title>Smithers</title>")
  const server = await startLocalServer({
    port: 0, distDir: root, stateDir: join(root, "state"), cloudMode: "offline",
    env: { SMITHERS_MODEL_KEY_LOOPBACK: key, SMITHERS_MODEL_KEY_LOOPBACK_ORIGIN: provider.origin }, log: () => {}
  })
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const http: Parameters<typeof loadBootstrap>[0] = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set(LOCAL_SESSION_HEADER, server.sessionToken)
    return fetch(new URL(String(input), server.origin), { ...init, headers })
  }
  const bootstrap = await loadBootstrap(http)
  const runtime = createRuntime({ bootstrap, http })
  const controller = createAppController(store, runtime.backend.agent ?? unavailableAgent(), { bootstrap, fetchImpl: http })
  try {
    await controller.adoptSession({ state: "unavailable", login: null, admin: false })
    expect(await controller.explain("the loopback provider")).toBe("There is no agent on this host to explain with.")
    expect(await provider.journal()).toHaveLength(0)
    await controller.commands.run("model.list")
    await waitFor(() => { const card = store.collections.cards.get("models"); return card?.kind === "models" && card.payload.host === "observed" })
    expect((await controller.commands.run("model.save", `--name loopback --protocol openai-chat --model ${PROVIDER_MODEL.answers} --credential LOOPBACK --url ${provider.origin}`)).status).toBe("executed")
    await controller.commands.run("model.test", "loopback")
    await waitFor(() => store.collections.models.get("loopback")?.lastTest !== undefined)
    expect(store.collections.models.get("loopback")?.lastTest?.result.ok).toBe(true)
    expect((await controller.commands.run("model.assign", "explainer loopback")).status).toBe("executed")
    expect((await controller.commands.run("agent.explain", "the loopback provider")).status).toBe("executed")
    await waitFor(() => [...store.collections.cards.values()].some((card) => card.kind === "explain" && card.payload.phase === "answered"))
    const answer = [...store.collections.cards.values()].find((card) => card.kind === "explain")
    expect(answer?.kind === "explain" && answer.payload).toMatchObject({ answer: PROVIDER_REPLY.join(""), answeredBy: "loopback", phase: "answered" })
    expect((await provider.journal()).map((entry) => [entry.modelId, entry.authorized])).toEqual([
      [PROVIDER_MODEL.answers, true], [PROVIDER_MODEL.answers, true]
    ])
    expect(bootstrap.capabilities).not.toContain("agent")
    expect(bootstrap.capabilities).toContain("model.turn")
    expect(runtime.backend.agent?.available).toBe(false)
  } finally {
    await controller.dispose()
    await server.stop()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  }
})
