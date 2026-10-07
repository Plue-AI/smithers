/** Contract-fixture executor: the real app agent dispatcher and shipped pages.
 * This is not the composed install's model host and grants no install receipt.
 */
import { createAppStore } from "../../src/mainview/state/AppStore"
import { createAppController } from "../../src/mainview/state/AppController"
import { memoryStorage, silentAgent } from "../../src/mainview/state/TestFixtures"
import { diskPageFiles } from "../../src/docs/DiskPages"
import { loadDocs } from "../../src/docs/Docs"

const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
const controller = createAppController(store, silentAgent, {
  docs: () => loadDocs(diskPageFiles()),
  fetchImpl: async () => Response.json({})
})
try {
  const result = await controller.commands.runForAgent("docs.read", "quickstart")
  if (result.status !== "executed" || !result.value) throw new Error("docs.read unavailable")
  process.stdout.write(result.value)
} finally {
  await controller.dispose()
}
