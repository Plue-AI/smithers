/**
 * A stateful stand-in for the GitHub REST endpoints the write-back actions
 * use, served by the real `node:http` fixture.
 *
 * Writes change the state, so a test asserts on what the repository ends up
 * holding rather than only on the requests. `lose` makes the next write apply
 * and then answer 502, the ambiguous case a retry must reconcile; `hold` makes
 * it apply and never answer, which is where a crash lands.
 */
import type { ServerResponse } from "node:http"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"

export interface FakeComment {
  readonly id: number
  readonly url: string
  body: string
}

export interface FakeCheckRun {
  readonly id: number
  readonly name: string
  readonly head_sha: string
  readonly external_id: string | null
  readonly html_url: string
  status: string
  conclusion: string | null
  output?: unknown
  details_url?: string
}

export interface FakeGitHub {
  readonly fixture: Fixture
  readonly comments: Array<FakeComment>
  labels: Array<string>
  readonly checkRuns: Array<FakeCheckRun>
  pullBody: string | null
  /** The next write applies, then answers 502. */
  lose: boolean
  /** The next write applies, then never answers; `held` resolves when it has. */
  hold: boolean
  readonly held: Promise<void>
  /** Every comment page links to another, forever. */
  endlessComments: boolean
  /** Every check-run listing claims more runs than it returns. */
  truncatedCheckRuns: boolean
  readonly writes: () => ReadonlyArray<string>
}

export const startGitHub = async (): Promise<FakeGitHub> => {
  let heldSignal: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    heldSignal = resolve
  })
  let nextId = 100
  const state: Omit<FakeGitHub, "fixture" | "writes" | "held"> = {
    comments: [],
    labels: [],
    checkRuns: [],
    pullBody: null,
    lose: false,
    hold: false,
    endlessComments: false,
    truncatedCheckRuns: false
  }
  const answer = (request: Recorded, response: ServerResponse, status: number, body: unknown) => {
    if (request.method !== "GET" && state.hold) {
      state.hold = false
      heldSignal()
      return
    }
    if (request.method !== "GET" && state.lose) {
      state.lose = false
      return json(response, 502, { message: "Bad Gateway" })
    }
    json(response, status, body)
  }
  const fixture = await startFixture((request, response) => {
    const url = new URL(request.url, "http://github.test")
    const path = url.pathname
    const body = request.body.length > 0 ? JSON.parse(request.body) : undefined
    if (path === "/repos/o/r/issues/7/labels") {
      if (request.method === "GET") return json(response, 200, state.labels.map((name) => ({ name })))
      for (const name of body.labels as Array<string>) {
        if (!state.labels.some((label) => label.toLowerCase() === name.toLowerCase())) state.labels.push(name)
      }
      return answer(request, response, 200, state.labels.map((name) => ({ name, color: "fff" })))
    }
    if (path === "/repos/o/r/issues/7/comments") {
      if (request.method === "GET") {
        const headers: Record<string, string> = state.endlessComments
          ? { link: `<${fixture.origin}${path}?page=${Number(url.searchParams.get("page") ?? 1) + 1}>; rel="next"` }
          : {}
        return json(response, 200, [{ id: 1, url: "u1", body: "unrelated" }, { bad: true }, ...state.comments], headers)
      }
      const comment = { id: nextId++, url: `https://api.github.test/comments/${nextId}`, body: body.body }
      state.comments.push(comment)
      return answer(request, response, 201, comment)
    }
    const edited = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(path)
    if (edited !== null) {
      const comment = state.comments.find((candidate) => candidate.id === Number(edited[1])) as FakeComment
      comment.body = body.body
      return answer(request, response, 200, comment)
    }
    const listed = /^\/repos\/o\/r\/commits\/([0-9a-f]+)\/check-runs$/.exec(path)
    if (listed !== null) {
      const runs = state.checkRuns.filter((run) =>
        run.head_sha === listed[1] && run.name === url.searchParams.get("check_name")
      )
      return json(response, 200, {
        total_count: runs.length + 1 + (state.truncatedCheckRuns ? 1 : 0),
        check_runs: [{ id: "not-a-run" }, ...runs]
      })
    }
    if (path === "/repos/o/r/check-runs" && request.method === "POST") {
      const run: FakeCheckRun = {
        id: nextId++,
        name: body.name,
        head_sha: body.head_sha,
        external_id: body.external_id ?? null,
        html_url: `https://github.test/o/r/runs/${nextId}`,
        status: body.status ?? "queued",
        conclusion: body.conclusion ?? null,
        ...(body.output === undefined ? {} : { output: body.output }),
        ...(body.details_url === undefined ? {} : { details_url: body.details_url })
      }
      state.checkRuns.push(run)
      return answer(request, response, 201, run)
    }
    const patchedRun = /^\/repos\/o\/r\/check-runs\/(\d+)$/.exec(path)
    if (patchedRun !== null) {
      const run = state.checkRuns.find((candidate) => candidate.id === Number(patchedRun[1])) as FakeCheckRun
      if (body.status !== undefined) run.status = body.status
      if (body.conclusion !== undefined) run.conclusion = body.conclusion
      if (body.output !== undefined) run.output = body.output
      if (body.details_url !== undefined) run.details_url = body.details_url
      return answer(request, response, 200, run)
    }
    if (path === "/repos/o/r/pulls/9") {
      if (request.method === "PATCH") state.pullBody = body.body
      return answer(request, response, 200, { html_url: "https://github.test/o/r/pull/9", body: state.pullBody })
    }
    json(response, 404, { message: "Not Found" })
  })
  return Object.assign(state, {
    fixture,
    held,
    writes: () =>
      fixture.requests.filter((request) => request.method !== "GET").map((request) =>
        `${request.method} ${new URL(request.url, "http://github.test").pathname}`
      )
  }) as FakeGitHub
}
