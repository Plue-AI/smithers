import { expect, test } from "bun:test"
import { createClock } from "../src/clock"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("clock snapshots stay stable until notification and stop with the last reader", async () => {
  let source = 1
  const clock = createClock(() => source, 5)
  source = 2
  expect(clock.snapshot()).toBe(1)
  let notifications = 0
  const first = clock.subscribe(() => notifications++)
  const second = clock.subscribe(() => notifications++)
  expect(clock.snapshot()).toBe(2)
  source = 3
  await sleep(20)
  expect(clock.snapshot()).toBe(3)
  const before = notifications
  await sleep(20)
  expect(notifications).toBe(before)
  first()
  source = 4
  await sleep(20)
  expect(clock.snapshot()).toBe(4)
  second()
  source = 5
  await sleep(20)
  expect(clock.snapshot()).toBe(4)
  const reconnect = clock.subscribe(() => {})
  expect(clock.snapshot()).toBe(5)
  reconnect()
})

test("a paused clock does not advance or notify", async () => {
  let source = 1
  const clock = createClock(() => source, 5, false)
  let notifications = 0
  const stop = clock.subscribe(() => notifications++)
  source = 2
  await sleep(20)
  expect(clock.snapshot()).toBe(1)
  expect(notifications).toBe(0)
  stop()
})
