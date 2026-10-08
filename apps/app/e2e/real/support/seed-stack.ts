import { expect, type Page } from "@playwright/test"

/**
 * Seeds a stack through the install's public API, as a member files TODOs
 * (C-J4-02 and C-J7-01 setup). Each TODO is appended with `POST /api/todos`,
 * in order; the fixture `todo` flow then settles it in the state its prompt's
 * markers select. Nothing else is written.
 */

/**
 * The fixture `todo` flow's prompt markers. The reference fixture matches the
 * words ASK, FAIL and FIXED; the bracketed forms contain them and are the
 * rehearsal's distribution/fake-todo-turns.mjs markers.
 */
export const marker = {
  pr: "[PR]",
  ask: "[ASK]",
  fail: "[FAIL]",
  fixed: "[FIXED]",
  hold: (key: string) => `[HOLD ${key}]`,
  file: (path: string) => `[FILE ${path}]`
} as const

export type TodoState = "queued" | "starting" | "working" | "needs_you" | "paused" | "failed" | "in_review" | "merged" | "dropped"
export type SeedTodo = { readonly title: string; readonly prompt: string; readonly state: TodoState }
export type MemberResponse = { readonly status: number; readonly body: any; readonly ms: number }

/** One request as the member whose browser holds `page`: their session, the double-submit CSRF pair and an Idempotency-Key. */
export const memberRequest = async (page: Page, method: string, path: string, data?: unknown, key?: string): Promise<MemberResponse> => {
  const target = new URL(path, page.url())
  const csrf = (await page.context().cookies(target.origin)).find(cookie => cookie.name === "__csrf")?.value
  const mutation = method !== "GET"
  if (mutation && (!csrf || !key)) throw new Error(`${method} ${path} needs the member's CSRF cookie and an Idempotency-Key`)
  const startedAt = performance.now()
  const response = await page.context().request.fetch(target.toString(), {
    method,
    headers: mutation ? { Origin: target.origin, "X-CSRF-Token": csrf!, "Idempotency-Key": key! } : {},
    ...(data === undefined ? {} : { data })
  })
  const ms = performance.now() - startedAt
  const text = await response.text()
  return { status: response.status(), body: text ? JSON.parse(text) : null, ms }
}

/** GET /api/todos/{n} as the member. */
export const readTodo = async (page: Page, n: number): Promise<any> => {
  const response = await memberRequest(page, "GET", `/api/todos/${n}`)
  expect(response.status, `GET /api/todos/${n}`).toBe(200)
  return response.body
}

/** GET /api/todos as the member: the Home card's rows in stack order. */
export const readStack = async (page: Page): Promise<any[]> => {
  const response = await memberRequest(page, "GET", "/api/todos")
  expect(response.status, "GET /api/todos").toBe(200)
  return response.body
}

/**
 * Files each TODO appended to the stack, then waits until every one reaches
 * its seeded state. Answers the TODO numbers in stack order. `run` makes the
 * Idempotency-Keys unique to this seeding.
 */
export const seedStack = async (page: Page, run: string, todos: readonly SeedTodo[], within = 15 * 60_000): Promise<number[]> => {
  const numbers: number[] = []
  for (const [index, todo] of todos.entries()) {
    const filed = await memberRequest(page, "POST", "/api/todos", { title: todo.title, prompt: todo.prompt, place: { mode: "append" } }, `${run}-seed-${index}`)
    expect(filed.status, `file ${todo.title}: ${JSON.stringify(filed.body)}`).toBe(202)
    expect(filed.body).toMatchObject({ state: "accepted", n: expect.any(Number) })
    numbers.push(filed.body.n)
  }
  for (const [index, todo] of todos.entries()) {
    await expect.poll(async () => (await readTodo(page, numbers[index]!)).state,
      { message: `T${numbers[index]} (${todo.title}) settles ${todo.state}`, timeout: within, intervals: [250, 500, 1000, 2000] }).toBe(todo.state)
  }
  const order = (await readStack(page)).map(card => card.n).filter(n => numbers.includes(n))
  expect(order, "the seeded TODOs keep their filing order").toEqual(numbers)
  return numbers
}
