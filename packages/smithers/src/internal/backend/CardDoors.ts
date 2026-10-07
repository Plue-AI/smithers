/** Person card doors open the configured install in the person's browser. */
import { Cli } from "incur"
import type { Runtime } from "../../cli/ControlBridge.ts"
import * as Presentation from "../../cli/Presentation.ts"
import { Refused } from "../../CliError.ts"
import catalog from "./catalog.mvp.json" with { type: "json" }
import { run } from "./Process.ts"
import { Session } from "./Session.ts"

export const mountCardDoors = (cli: Cli.Cli<any, any, any, any>, runtime: Runtime) => {
  const commands = Cli.toCommands.get(cli as never)!
  for (const name of ["settings", "members", "secrets"]) {
    const row = catalog.operations.find((row) => row.name === name)!
    const door = Cli.create("root").command(name, {
      description: row.summary,
      mcp: false,
      run: (context: any) =>
        Presentation.guard(context, async () => {
          if (Presentation.current()?.transport === "mcp") {
            throw new Refused({
              fault: "policy",
              code: "never",
              class: "never",
              message: "Only a person can open this card"
            })
          }
          const env = runtime.environment ?? process.env
          const url = new URL(new Session(env).target().api_url)
          url.searchParams.set("card", name)
          const result = await run(process.platform === "darwin" ? "open" : "xdg-open", [url.href], {
            env,
            timeoutMs: 10_000,
            signal: runtime.signal
          })
          if (result.code !== 0) {
            throw new Refused({ fault: "infra", code: "browser_unavailable", message: "Could not open the app" })
          }
          return { card: name, opened: true }
        }, { next: [], render: () => ({ human: "Opened" }) })
    })
    commands.set(name, Cli.toCommands.get(door)!.get(name)!)
  }
}
