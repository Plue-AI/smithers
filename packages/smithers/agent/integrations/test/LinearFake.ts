/**
 * A stateful stand-in for the Linear GraphQL operations the durable actions
 * use, served by the real `node:http` fixture.
 *
 * `lose` makes the next mutation apply and then answer 502; `hold` makes it
 * apply and never answer, which is where a crash lands.
 */
import { type Fixture, json, startFixture } from "./Fixture.ts"

export interface FakeIssue {
  readonly id: string
  readonly identifier: string
  title: string
  priority: number
  readonly comments: Array<{ readonly id: string; readonly body: string }>
}

export interface FakeLinear {
  readonly fixture: Fixture
  readonly issue: FakeIssue
  lose: boolean
  hold: boolean
  readonly held: Promise<void>
  /** Operation names of the mutations received, in order. */
  readonly mutations: () => ReadonlyArray<string>
}

const ISSUE_ID = "3f1c9d2e-0000-4000-8000-000000000001"

export const startLinear = async (): Promise<FakeLinear> => {
  let heldSignal: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    heldSignal = resolve
  })
  const issue: FakeIssue = { id: ISSUE_ID, identifier: "ENG-1", title: "Parser", priority: 0, comments: [] }
  const view = () => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: "https://linear.test/ENG-1",
    team: { id: "team-1", key: "ENG" }
  })
  const state = { issue, lose: false, hold: false }
  const fixture = await startFixture((request, response) => {
    const { query, variables } = JSON.parse(request.body) as { query: string; variables: Record<string, any> }
    const mutation = /^\s*mutation\b/.test(query)
    const reply = (data: unknown) => {
      if (mutation && state.hold) {
        state.hold = false
        heldSignal()
        return
      }
      if (mutation && state.lose) {
        state.lose = false
        return json(response, 502, { errors: [{ message: "Bad Gateway" }] })
      }
      json(response, 200, { data })
    }
    const known = (id: string) => id === issue.id || id === issue.identifier
    if (query.includes("SmithersComment")) {
      if (!known(variables["issue"])) return json(response, 200, { data: { issue: null } })
      return reply({
        issue: {
          id: issue.id,
          comments: { nodes: issue.comments.filter((comment) => comment.id === variables["comment"]) }
        }
      })
    }
    if (query.includes("commentCreate")) {
      const input = variables["input"]
      if (issue.comments.some((comment) => comment.id === input.id)) {
        return json(response, 200, { errors: [{ message: "Entity already exists" }] })
      }
      const comment = { id: input.id ?? `generated-${issue.comments.length}`, body: input.body }
      issue.comments.push(comment)
      return reply({ commentCreate: { success: true, comment: { ...comment, issue: { id: issue.id } } } })
    }
    if (query.includes("issueUpdate")) {
      const input = variables["input"]
      if (input.title !== undefined) issue.title = input.title
      if (input.priority !== undefined) issue.priority = input.priority
      return reply({ issueUpdate: { success: true, issue: view() } })
    }
    if (query.includes("query Issue(")) return reply({ issue: known(variables["id"]) ? view() : null })
    json(response, 400, { errors: [{ message: `unexpected ${query}` }] })
  })
  return Object.assign(state, {
    fixture,
    held,
    mutations: () =>
      fixture.requests.map((request) => JSON.parse(request.body).query as string)
        .filter((query) => /^\s*mutation\b/.test(query))
        .map((query) => /^\s*mutation\s+(\w+)/.exec(query)?.[1] ?? "?")
  }) as FakeLinear
}
