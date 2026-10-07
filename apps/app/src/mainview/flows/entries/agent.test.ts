import { expect, test } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { MessageSchema, ToastSchema } from "../../state/AppState"
import { memoryStorage, unavailableAgent } from "../../state/TestFixtures"

for (const capabilities of [[], ["launch.codex", "launch.claude-code"]] as const) test(`provider launch capabilities never add app catalog doors: ${capabilities}`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const launches: string[] = []
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: [...capabilities], authFlow: "none", sandbox: null },
    fetchImpl: async input => { if (String(input).includes("launch")) launches.push(String(input)); return new Response(null, { status: 404 }) }
  })
  try {
    for (const name of ["agent.codex", "agent.claude"]) {
      expect(controller.commands.find(name)).toBeUndefined()
      expect((await controller.commands.run(name, "Fix it")).status).not.toBe("executed")
      expect((await controller.commands.runForAgent(name, "Fix it")).status).not.toBe("executed")
      const saved = { flow: name, args: JSON.stringify({ prompt: "Private prompt" }), label: "Start" }
      const action = MessageSchema.shape.action.parse(saved)!
      expect(action).toMatchObject({ flow: "agents", args: undefined })
      expect(ToastSchema.shape.action.parse(saved)).toEqual(action)
      expect(JSON.stringify(action)).not.toContain("Private prompt")
    }
    expect(launches).toEqual([])
  } finally { await controller.dispose() }
})
