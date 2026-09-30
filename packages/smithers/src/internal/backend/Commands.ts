/**
 * Backend commands mounted into the single npm CLI command tree.
 * @since 1.0.0
 */

import { Cli, Completions, z } from "incur"
import type { Runtime } from "../../cli/ControlBridge.ts"
import * as Presentation from "../../cli/Presentation.ts"
import { Refused } from "../../CliError.ts"
import * as Failure from "../Failure.ts"
import { admin } from "./Admin.ts"
import { ask } from "./AgentDocs.ts"
import { auth } from "./Auth.ts"
import { Client, list, object, type Values } from "./Client.ts"
import { copy } from "./Copy.ts"
import { definitions } from "./Definitions.ts"
import { history, humans } from "./History.ts"
import { local } from "./Local.ts"
import { misc } from "./Misc.ts"
import { repositories } from "./Repositories.ts"
import { type Handler, resources } from "./Resources.ts"
import { runs } from "./Runs.ts"
import { stacks } from "./Stack.ts"
import { workspaces } from "./Workspaces.ts"

/** @private
 * @since 1.0.0
 */
export const handlers: Record<string, Handler> = {
  ...resources,
  ...admin,
  ...auth,
  ...local,
  ...repositories,
  ...runs,
  ...misc,
  ...workspaces,
  ...stacks,
  ...history,
  "agent ask": ask,
  "workspace cp": copy,
  completion: async (_c, a) => Completions.register(a.shell as "bash" | "zsh" | "fish", "smithers")
}
// Options that choose which backend receives the saved login.
const destinations = ["hostname", "host"] as const
/** @private
 * @since 1.0.0
 */
export const commandPath = (name: string): string =>
  name === "status"
    ? "change status"
    : name.startsWith("run ")
    ? name.replace(/^run /, "runs ").replace(/ view$/, " show")
    : name === "workflow watch"
    ? "runs watch"
    : name === "workflow run"
    ? "flow start"
    : name.startsWith("workflow ")
    ? name.replace(/^workflow /, "flow ")
    : /^cache (clear|list|stats)$/.test(name)
    ? name.replace("cache ", "cache cloud ")
    : name
// The remote homepage's blocks, one `type  title` line each, in server order.
const repoHome = (value: unknown): string | undefined =>
  Array.isArray(object(value).blocks)
    ? list(object(value).blocks).map((block) => {
      const row = object(block)
      return [row.type, row.title || row.name || ""].map(Presentation.clean).join("  ").trimEnd()
    }).join("\n")
    : undefined
/** @private
 * @since 1.0.0
 */
export const mount = (cli: Cli.Cli<any, any, any, any>, runtime: Runtime) => {
  const tree = Cli.toCommands.get(cli as never)!
  for (const [name, definition] of Object.entries(definitions)) {
    const handler = handlers[name]
    if (!handler) throw new Error(`Missing backend command: ${name}`)
    // workflow watch is the same handler and contract as run watch.
    if (name === "workflow watch") continue
    const words = commandPath(name).split(" ")
    let parent = tree
    for (const word of words.slice(0, -1)) {
      let entry = parent.get(word)
      if (!entry) {
        const group = Cli.create(word, { description: word })
        const temporary = Cli.create("root").command(group)
        entry = Cli.toCommands.get(temporary)!.get(word)!
        parent.set(word, entry)
      }
      if (!("_group" in entry)) throw new Error(`Cannot mount backend group ${word}`)
      parent = entry.commands
    }
    const leaf = words.at(-1)!, previous = parent.get(leaf)
    if (previous && ("_group" in previous || "_alias" in previous || "_fetch" in previous)) {
      throw new Error(`Cannot merge backend command ${name}`)
    }
    const cloud = name.startsWith("run ") || ["workflow list", "workflow run"].includes(name)
    const options = previous?.options ? definition.options.extend(previous.options.shape) : definition.options
    const args = name === "completion"
      ? z.object({ shell: z.enum(["bash", "zsh", "fish"]) })
      : previous?.args ?? definition.args
    const interactive = name === "api" || name === "config set" || name === "completion" ||
      (name.startsWith("auth ") && !name.endsWith(" status") && name !== "auth token") ||
      ["workspace shell", "workspace ssh"].includes(name)
    const human = name === "repo home" ? repoHome : humans[name]
    const command = {
      ...previous,
      mcp: interactive ? false as const : previous?.mcp ?? {
        annotations: {
          readOnlyHint:
            /(?:^| )(?:list|view|home|show|status|stats|health|token|connections|get|index|history|revisions|logs|watch|checks|conflicts|files|diff)$/
              .test(name) || name.startsWith("search ")
        }
      },
      description: previous?.description ?? definition.description,
      args,
      options: cloud
        ? options.extend({ cloud: z.boolean().default(false).describe("Use repository flows and runs on the backend") })
        : options,
      alias: { ...previous?.alias, ...(Object.hasOwn(definition.options.shape, "repo") ? { repo: "R" } : {}) },
      run: (context: any) => {
        if (previous && !context.options.cloud && context.options.repo === undefined) {
          return previous.run({ ...context, options: previous.options?.parse(context.options) ?? context.options })
        }
        const options: Values = context.options,
          args: Values = {
            ...context.args,
            ...(context.args.run ? { id: context.args.run } : {}),
            ...(context.args.flow ? { workflow: context.args.flow } : {})
          }
        return Presentation.guard(
          context,
          async () => {
            // The backend an MCP session reaches, and the login it presents, are
            // host configuration: a caller never aims the host's credential elsewhere.
            if (Presentation.current()?.transport === "mcp") {
              if (["api", "auth login", "config set"].includes(name)) {
                throw new Refused({
                  fault: "policy",
                  code: "host_owned",
                  message: "Login and API destination configuration are host-owned over MCP"
                })
              }
              for (const flag of destinations) {
                if (options[flag] !== undefined && options[flag] !== "") {
                  throw new Refused({
                    fault: "policy",
                    code: "host_owned",
                    message: `--${flag} is not accepted over MCP; the backend destination is host-owned`
                  })
                }
              }
            }
            const structured = Presentation.policy(context, runtime).structured
            const client = new Client(runtime, !structured)
            try {
              const value = client.redact(await handler(client, args, options))
              // The human renderer cleans its own text and JSON escapes control
              // characters; toon, yaml and md print backend strings as they are.
              return structured && context.format !== "json" && context.format !== "jsonl"
                ? Failure.terminalSafeValue(value)
                : value
            } catch (error) {
              throw client.failure(error)
            } finally {
              client.flushOutput()
            }
          },
          human === undefined ? {} : { next: [], render: (value) => ({ human: human(value) }) }
        )
      }
    }
    const temporary = Cli.create("root").command(leaf, command)
    parent.set(leaf, Cli.toCommands.get(temporary)!.get(leaf)!)
  }
  const authGroup = tree.get("auth")!
  if ("_group" in authGroup) tree.set("login", authGroup.commands.get("login")!)
  tree.set("issues", { _alias: true, target: "issue" } as never)
}
