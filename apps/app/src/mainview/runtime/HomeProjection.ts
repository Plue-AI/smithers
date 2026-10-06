import { HomeCardSchema } from "@smthrs/rpc/HomeCard"

/** Source facts carry the historical shared stack aggregate. Other Home rows
 * keep their existing committed providers and periodic snapshots. */
export function projectHome(previous: unknown, delta: unknown) {
  const before = HomeCardSchema.parse(previous)
  const fact = delta as { Type?: unknown; Data?: { home?: unknown } } | undefined
  if (typeof fact?.Type !== "string" || !fact.Type.startsWith("todo.")) throw new Error("Invalid Home source fact")
  const patch = HomeCardSchema.pick({ items: true, counts: true }).parse(fact.Data?.home)
  return HomeCardSchema.parse({ ...before, ...patch })
}
