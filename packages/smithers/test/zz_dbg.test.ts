import { it } from "vitest"
import * as NodeControl from "/Users/williamcory/smithers/packages/smithers/src/NodeControl.ts"
import * as Providers from "/Users/williamcory/smithers/packages/smithers/src/Providers.ts"
it("x", async () => {
  const session = JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", account_id: "acct" } })
  console.log(await NodeControl.seatCandidates({ environment: { SMITHERS_OPENAI_AUTH: "chatgpt", CODEX_HOME: "/codex" }, homeDirectory: "/home/op", readFile: (p: string) => (p === "/codex/auth.json" ? session : undefined) }))
  console.log(Providers.expandSeat("sol"))
})
