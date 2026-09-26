/** The shared worker and flow-run lifecycle: every transition, and the seat pool's queue. */
import { describe, expect, it } from "bun:test"
import * as Lifecycle from "../src/lifecycle.ts"

/**
 * Every (status, event) pair. A cell is the next status with a free seat, then
 * after `/` the next status when every seat is taken; `-` means the event does
 * not apply.
 */
const table = `
            admit      launch   input  fill       block    unblock  park    wake            sleep   retry             reattach  done  fail    cancel
queued      requested  -        -      -          -        -        parked  running         -       -                 -         done  failed  cancelled
requested   -          running  input  -          -        -        parked  -               -       -                 -         done  failed  cancelled
input       -          -        -      requested  -        -        -       -               -       -                 -         done  failed  cancelled
running     -          -        -      -          waiting  running  parked  -               -       -                 -         done  failed  cancelled
waiting     -          -        -      -          waiting  running  parked  -               -       -                 -         done  failed  cancelled
parked      -          parked   -      -          -        -        parked  running/queued  -       -                 -         done  failed  cancelled
done        -          -        -      -          -        -        -       -               -       -                 -         done  failed  cancelled
failed      -          -        -      -          -        -        -       -               parked  requested/queued  running   done  failed  cancelled
cancelled   -          -        -      -          -        -        -       -               -       requested/queued  running   done  failed  cancelled
`

const [header, ...rows] = table.trim().split("\n").map((line) => line.trim().split(/\s+/))
const columns = header! as ReadonlyArray<Lifecycle.Event>

describe("step", () => {
  it("the table names every status and every event exactly once", () => {
    expect(rows.map((row) => row[0])).toEqual([...Lifecycle.statuses])
    expect(columns).toEqual([...Lifecycle.events])
  })

  const pairs = rows.flatMap((row) =>
    columns.map((event, index) => ({ status: row[0] as Lifecycle.Status, event, cell: row[index + 1]! }))
  )
  it.each(pairs.map((pair) => [pair.status, pair.event, pair.cell] as const))(
    "%s + %s -> %s",
    (status, event, cell) => {
      const [free = cell, full = free] = cell.split("/")
      const expected = (target: string) => (target === "-" ? undefined : target as Lifecycle.Status)
      expect(Lifecycle.step(status, event, false)).toBe(expected(free))
      expect(Lifecycle.step(status, event, true)).toBe(expected(full))
    }
  )

  it("maps each reported outcome to its event", () => {
    for (const outcome of ["done", "failed", "cancelled"] as const) {
      expect(Lifecycle.step("running", Lifecycle.ending[outcome], false)).toBe(outcome)
    }
  })
})

interface Record {
  readonly id: string
  readonly status: Lifecycle.Status
  readonly note?: string
}

const pool = (seats = 1) => {
  const persisted: Array<{ readonly record: Record; readonly known: boolean }> = []
  const admitted: Array<string> = []
  const notified: Array<number> = []
  const made: Lifecycle.Pool<Record, string> = new Lifecycle.Pool<Record, string>({
    name: "test",
    seats,
    holdsSeat: (record) => record.status === "requested" || record.status === "running",
    persist: (record) => persisted.push({ record, known: made.get(record.id) === record }),
    admit: (record, entry) => {
      admitted.push(entry)
      made.move(record, "admit")
    }
  })
  made.subscribe(() => notified.push(made.values().length))
  return { pool: made, persisted, admitted, notified }
}

describe("Pool", () => {
  it("persists a record before remembering it, then notifies", () => {
    const f = pool()
    const created = f.pool.create({ id: "a" })
    expect(created.status).toBe("requested")
    expect(f.persisted).toEqual([{ record: created, known: false }])
    expect(f.notified).toEqual([1])
  })

  it("queues a request once every seat is taken and admits the queue oldest first", () => {
    const f = pool()
    f.pool.create({ id: "a" })
    for (const id of ["b", "c"]) {
      expect(f.pool.create({ id }).status).toBe("queued")
      f.pool.enqueue(id, id)
    }
    f.pool.move(f.pool.get("a")!, "done")
    expect(f.admitted).toEqual(["b"])
    expect(f.pool.get("b")?.status).toBe("requested")
    f.pool.move(f.pool.get("b")!, "fail")
    expect(f.admitted).toEqual(["b", "c"])
  })

  it("moves an id queued again to the back", () => {
    const f = pool()
    f.pool.create({ id: "a" })
    for (const id of ["b", "c"]) {
      f.pool.create({ id })
      f.pool.enqueue(id, id)
    }
    f.pool.enqueue("b", "b again")
    f.pool.move(f.pool.get("a")!, "done")
    expect(f.admitted).toEqual(["c"])
  })

  it("skips an entry whose record left the queue, and dequeue returns what it carried", () => {
    const f = pool()
    f.pool.create({ id: "a" })
    for (const id of ["b", "c"]) {
      f.pool.create({ id })
      f.pool.enqueue(id, id)
    }
    f.pool.move(f.pool.get("b")!, "cancel")
    expect(f.pool.dequeue("c")).toBe("c")
    expect(f.pool.dequeue("c")).toBeUndefined()
    f.pool.move(f.pool.get("a")!, "done")
    expect(f.admitted).toEqual([])
  })

  it("an event that does not apply writes nothing", () => {
    const f = pool()
    const created = f.pool.create({ id: "a" })
    expect(f.pool.move(created, "fill")).toBeUndefined()
    expect(f.persisted).toHaveLength(1)
    expect(f.pool.get("a")).toBe(created)
  })

  it("a change that keeps the status is written without a transition", () => {
    const f = pool()
    const created = f.pool.create({ id: "a" })
    f.pool.put({ ...created, note: "x" })
    expect(f.pool.get("a")).toEqual({ id: "a", status: "requested", note: "x" })
    expect(f.persisted).toHaveLength(2)
  })

  it("adopt and forget change memory without writing", () => {
    const f = pool()
    f.pool.adopt({ id: "a", status: "failed" })
    expect(f.pool.has("a")).toBe(true)
    f.pool.forget("a")
    expect(f.pool.has("a")).toBe(false)
    expect(f.persisted).toEqual([])
  })

  it("closing stops admission and hands back what was queued", () => {
    const f = pool()
    f.pool.create({ id: "a" })
    f.pool.create({ id: "b" })
    f.pool.enqueue("b", "b")
    expect(f.pool.close()).toEqual(["b"])
    f.pool.move(f.pool.get("a")!, "done")
    expect(f.admitted).toEqual([])
    expect(f.pool.get("b")?.status).toBe("queued")
  })

  it("a parked record wakes into the queue when every seat is taken", () => {
    const f = pool()
    f.pool.adopt({ id: "p", status: "parked" })
    f.pool.create({ id: "a" })
    expect(f.pool.move(f.pool.get("p")!, "wake")?.status).toBe("queued")
  })
})
