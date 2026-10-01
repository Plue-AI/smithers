---
title: "Burn down a backlog"
description: "Apply the @smthrs/patterns Burndown pattern to GitHub issues: discover, select, claim, work each issue as a durable child, land, release, and park when capacity runs out."
---

`Burndown` works a backlog until nothing in it is yours. Each round it
rediscovers the backlog, selects the items that are yours, claims them, works
each one as a durable child execution, lands each result as its work finishes,
one at a time unless `landConcurrency` allows more, and releases every claim. This guide applies it to the open issues of a GitHub
repository. The same members fit Linear tickets or a message queue; only the
four provider calls change.

## The shape

```text
round N:  capacity? ─┬─ Available(slots) ─▶ discover ─▶ dispatch ─┬─ launched > 0 ─▶ Flow.to(round N+1)
                     ├─ WaitUntil(at) ───▶ Sleep ──▶ Flow.to(N+1)  └─ launched = 0 ─▶ drained
                     └─ Exhausted ───────▶ WaitFor(signal) ──▶ Flow.to(N+1)

dispatch: select ─▶ slot: claim ─▶ work (child: key/id) ─┬─▶ land (queue)  ─▶ release
                    ▲                                    │
                    └── capacity allows? next ours item ─┘
```

A slot hands its item to the landing queue when the work finishes and takes
the next item at once, so one slow item never holds another slot idle or
delays a finished item's landing.

`Burndown.make` declares the lineage. `Burndown.round` is the Effect a
dispatch runs, because the number of issues is a runtime fact that no plan
knows when it is built. `Burndown.layer` connects the two.

## Declare the provider steps

Discovery and capacity are ordinary actions. Discovery answers an array of
items with a stable string `id`; capacity answers one of
`Burndown.available(slots)`, `Burndown.waitUntil(epochMillis)`, or
`Burndown.exhausted(detail)`.

```ts
import { Action } from "@smthrs/flow"
import { Burndown } from "@smthrs/patterns"
import * as Schema from "effect/Schema"

const Repo = Schema.Struct({ repo: Schema.String })

export const ListIssues = Action.make("issues/list", {
  payload: { input: Repo, round: Schema.Number },
  success: Schema.Array(Schema.Struct({ id: Schema.String, number: Schema.Number })),
  nondeterministic: true
})

export const Accounts = Action.make("issues/accounts", {
  payload: { input: Repo, round: Schema.Number },
  success: Burndown.Capacity,
  nondeterministic: true
})

// One dispatch per round; Burndown.layer implements it below.
export const Dispatch = Burndown.dispatch("issues/dispatch")
```

Use the issue number as the id (`"3265"`), so the claim, the row, and the
child execution all name the same issue.

## Declare the burndown

```ts
export default Burndown.make({
  name: "issues/burndown",
  discover: ListIssues,
  capacity: Accounts,
  dispatch: Dispatch,
  maxRounds: 50,
  deadline: "12 hours",
  signal: "accounts-reset"
})
```

Start it with `{ input: { repo: "smithersai/smithers" } }`. The lineage ends
`drained` when a round launches nothing, or `max_rounds` when the budget runs
out. A round spent parked counts against `maxRounds`.

## Implement the round

```ts
import * as Effect from "effect/Effect"
import Work from "./work/flow.ts"

interface Issue {
  readonly id: string
  readonly number: number
}

// Your own gh wrappers; each returns an Effect.
declare class GhFailed {
  readonly message: string
}
declare const liveClaimHost: (repo: string, issue: number) => Effect.Effect<string | undefined, GhFailed>
declare const claimIssue: (repo: string, issue: number) => Effect.Effect<"claimed" | "held", GhFailed>
declare const mergePatch: (repo: string, patch: string) => Effect.Effect<string, GhFailed>
declare const releaseIssue: (repo: string, issue: number, note: string) => Effect.Effect<void, GhFailed>
declare const readAccounts: (repo: string) => Effect.Effect<Burndown.Capacity, GhFailed>

export const dispatchLayer = Burndown.layer(Dispatch, {
  key: "issues/smithersai-smithers",
  concurrency: 12,
  select: ({ input, item }: Burndown.ItemArgs<{ repo: string }, Issue>) =>
    Effect.map(
      liveClaimHost(input.repo, item.number),
      (host) => host === "Williams-Mac-mini.local" ? Burndown.skip(`claimed on ${host}`) : Burndown.ours
    ),
  claim: ({ input, item }) =>
    Effect.flatMap(
      claimIssue(input.repo, item.number),
      (answer) =>
        answer === "held" ? Effect.fail(new Burndown.Held({ message: "claimed by another worker" })) : Effect.void
    ),
  work: Burndown.child(Work, ({ input, item }) => ({ repo: input.repo, issue: item.number })),
  // land answers the merged revision; detail and release both see it.
  land: ({ input, output }) => mergePatch(input.repo, output.patch),
  release: ({ input, item, status, detail }) => releaseIssue(input.repo, item.number, `${status}: ${detail}`),
  detail: (report, revision) => `${revision}: ${report.changed}`,
  // Asked each time a slot frees; the same answer the Accounts action gives.
  capacity: ({ input }) => readAccounts(input.repo)
})
```

Provide `dispatchLayer`, the `ListIssues` and `Accounts` implementations,
`Sleep.layer`, and `WaitFor.layer` to the host that executes the burndown.

What each member decides:

| Member      | Runs                                                                | Its failure                                                 |
| ----------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `select`    | For every unsettled item                                            | Skips the item this round; the next round asks again        |
| `claim`     | For each item a slot admits                                         | `Held` settles it `held`; anything else settles it `failed` |
| `work`      | After a successful claim                                            | Settles it `failed`; the items beside it keep running       |
| `land`      | In the order work finished, `landConcurrency` at a time (default 1) | Settles it `failed`; the next landing still runs            |
| `release`   | Once per successful claim, when the item settles                    | Appended to the row's detail; the status stays              |
| `capacity`  | When a slot frees and an item is still waiting                      | Admits nothing through that slot                            |
| `cancelled` | When an item's work or the round is interrupted                     | Counts as no cancel: the item is requeued                   |

## Rolling admission

The first `slots` items that are ours launch on the capacity the lineage
asked for, at most `slots` at a time. When an item finishes working, its slot
asks the round's `capacity` member and admits the next item only on
`Burndown.available(n)` with `n` above the work still in flight. On any other
answer the slot retires. The items no slot admitted are `deferred`: the next
round rediscovers them, and its capacity gate parks if the accounts are out.

Without a round `capacity` member the round launches `slots` items and defers
the rest, because nothing says the capacity still holds.

## Concurrent landing

`landConcurrency` lets several landings run at once; they still start in the
order work finished. Use it when most of a landing is checks that can run side
by side, such as tests in separate checkouts, and serialize the step that must
stay serial, such as moving `main`, inside `land` itself.

`release` receives the row's final `status` and `detail`. `detail` renders a
landed row from the work output and what `land` answered.

A settled item (`landed`, `held`, `failed`) is never retried within the
lineage. A new burndown with the same `key` reattaches to each child's
recorded outcome, including a failure, so retry failures under a new `key`
or a new execution id.

An interruption settles an item only when `cancelled` reports a recorded
operator cancel; the item is then `failed` with `work: interrupted`. Any other
interruption, such as a child released because its host's lease lapsed, is
`requeued`: `release` receives status `requeued`, the item stays unsettled,
and the next round, or the resumed run, claims and works it again.

## Restart without duplicates

`work` receives `executionId` `${key}/${item.id}`, here
`issues/smithersai-smithers/3265`. `Burndown.child` passes it to
`Work.execute`, so when a crashed round runs again, or a new burndown starts
with the same `key`, each issue reaches the child execution that already
exists instead of starting a second agent. Keep `key` stable per repository.

## Resume after capacity runs out

When `Accounts` answers `Burndown.waitUntil(resetAt)`, the round sleeps on a
durable timer and the next round asks again. When it answers
`Burndown.exhausted("every account is out of credit")`, the round parks on the
`accounts-reset` wait point and launches nothing until an operator resolves
it:

```ts
import { DurableDeferred } from "@smthrs/flow"

const gate = Burndown.signal("accounts-reset")
const token = DurableDeferred.tokenFromExecutionId(gate, { flow: burndown, executionId: parkedRoundId })
yield* DurableDeferred.succeed(gate, { token, value: { reset: true } })
```

The parked round's waiting row also carries this token.

## Limits

- `round` keeps every row of a round in memory, and the lineage carries every
  row in the next round's payload. Size `maxRounds` and the backlog for that.
- `select` reads claims before `claim` takes one, so two workers can both
  select an item. The claim is the arbiter: the loser gets `Held`.
- A `discover` call that answers a malformed backlog fails the dispatch with
  an `invalid_input` `PatternError` before any claim.

The reference for every export is in [the API reference](./api.md#burndown).
