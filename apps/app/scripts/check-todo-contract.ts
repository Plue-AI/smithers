import { createInterface } from "node:readline"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { todoActors } from "../src/mainview/state/ProductActor"
const check = (body: unknown) => {
 for (const value of Array.isArray(body) ? body : [body]) TodoCardSchema.parse(todoActors(value))
}
if (process.argv.includes("--stream")) {
 for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try { check(JSON.parse(line)); console.log(JSON.stringify({ ok: true })) }
  catch (error) { console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })) }
 }
} else check(JSON.parse(await Bun.stdin.text()))
