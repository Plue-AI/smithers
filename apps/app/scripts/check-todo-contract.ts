import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { todoActors } from "../src/mainview/state/ProductActor"
const input = await Bun.stdin.text()
const body: unknown = JSON.parse(input)
for (const value of Array.isArray(body) ? body : [body]) TodoCardSchema.parse(todoActors(value))
