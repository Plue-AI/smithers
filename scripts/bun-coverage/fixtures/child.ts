import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import { choose, optional, location } from "./source.ts"
const { View } = await import("./view.tsx")
assert.equal(choose(true), "positive")
assert.equal(optional(), 3)
assert.equal(location, new URL("./source.ts", import.meta.url).href)
const element = View({ name: "Ada" })
assert.equal(element.type, "span")
assert.equal(element.props.children, "Ada")
const database = new Database(":memory:")
try { assert.equal(database.query("select 7 as n").get().n, 7) } finally { database.close() }
console.log(`child:positive:${process.env.SPECIAL}`)
console.error("child-stderr")
process.exitCode = Number(process.argv[2] ?? 0)
