# HTTP turn recovery

The active HTTP chat path records a turn attempt before its first model POST.
`httpTurns` stores the transcript turn ID, distinct attempt ID, observed account
owner, current leg, completion state, received-text flag and claim-check state.
`httpTurnLegs` stores each leg's identity, ordinal, private journal capability,
applied cursor, pending tool call and settled result. Function-call input/output
pairs and the executed-leg count are derived from ordered legs; there is no
second mutable `toolItems` array for this path.

An explicit `chat.retry` keeps the original user-message identity and creates a
new attempt and leg. HTTP command intent identity includes the account, actor,
attempt, leg, call ID and command name. Replaying an old call cannot accidentally
become an explicit retry, and an explicit retry is not suppressed because a
provider happened to reuse its call ID.

## Accepted output and local application

The server persists output batches. A live socket delivers `accepted`, `batch`
and `caught-up` observations; it does not own a second transcript. `WebAgent`
awaits its journal subscriber before processing the next delivery. A socket
ending without a terminal batch does not synthesize a model `done` fact.
Terminal delivery ends at the first terminal item, even when later NDJSON lines
share its HTTP chunk.
The production `createAgentSeat` forwards that journal interface and its awaited
receipts. It retains the recording backend for replay, cancellation and later
legs even if the in-page chain is subsequently bound.

`http.turn.batch.received` is one semantic application event. Its pure reducer
verifies the complete batch's SHA-256, run/leg identity, predecessor hash and
contiguous positions before projecting any field. It folds every frame, held
claim, pending call and the new cursor in one projection and persistence
transaction. Existing transcript and card reducer cases are reused as internal
pure facts. Multiple act rows in a batch use stable frame-position IDs under
the single application revision. A duplicate or older self-consistent batch
does not append text, create another card or execute a tool.

The cursor means **the whole batch committed locally**, never bytes received or
the server's current head. An `existing` response to the initial POST supplies
no local application evidence; the client reads from its own saved cursor.
A malformed JSON admission releases the local request handle so the same turn
can retry.
Catch-up exhausts bounded pages and serializes application with live delivery.
Periodic reads repair socket loss. The pure event replay path does not enter
the controller or execute a model, command, provider or filesystem action.
Permanent replay refusals (including retired output and a mismatched cursor)
settle an unknown outcome without another inference. Malformed responses and
invalid replay boundaries settle an integrity refusal while preserving the
applied prefix. Network errors and temporary storage unavailability remain
retryable reads; they never authorize another model POST.

An accepted leg whose producer dies without recording a terminal batch is a
remaining liveness gap. Reads can return the same valid nonterminal prefix
forever. The local turn remains `active` and its leg `streaming`, meaning an
unresolved answer, not verified provider liveness. There is no producer lease
or persisted death observation to settle it automatically. The client keeps
polling and never launches replacement inference; the human may Stop and then
explicitly retry. Socket reconnection and output replay do not recover a dead
producer that never committed its remaining output.

## Effect boundaries and crash outcomes

| Last durable fact | Recovery behavior |
| --- | --- |
| No `http.turn.started` receipt | No model POST is allowed. |
| Prepared leg and private capability | Read the accepted output using that capability. Do not blindly POST another inference. If the saved leg cannot be found after reopening, record an unknown outcome. |
| Accepted cursor or partial batches | Read after the last applied cursor; restore text and held claims without repeating them. |
| Terminal batch asking for a tool | The controller may admit that previously unstarted tool. It first persists `http.tool.started`, then enters the shared durable command-intent door. |
| `http.tool.started`, no `http.tool.settled` | Report an unknown tool outcome. The tool may already have run; neither the tool nor a continuation is started automatically. |
| Settled tool result, no next leg | Derive continuation items from the saved result and prepare a fresh leg before its POST. The tool is not rerun. |
| Failed local batch or tool receipt | Stop this controller's HTTP effect driver and report the failure. No tool or continuation follows optimistic state. The person can stop the turn; reopening verifies the last committed prefix. |
| Terminal turn batch | Restore the settled presentation; no recovery work is started. |

The `http.tool.started` marker deliberately precedes actual invocation. A crash
between that marker and the shared command acceptance can conservatively leave
an unknown outcome even if nothing happened. This loses automatic progress to
avoid silently repeating accepted work. The shared command door independently
records acceptance and settlement; its approval-only retry exception remains
documented in [command-intents.md](command-intents.md).

Claim checking is retained across every batch and reload. Text withheld after a
run launch, or because the user's ask names an unavailable capability, stays in
`claimBuffer`. Terminal projection evaluates the whole answer and uses the same
deterministic claim policy as ordinary turns. Whitespace-only held responses
still use the empty-answer failure path. Cancellation and tool limits outrank
pending calls. Runtime-owned cards retain their existing update protections.

New legs compose current instructions/context immediately before their POST.
This implementation does not persist an exact copy of that complete request or
claim to reconstruct a lost original prompt context. Recovery reads accepted
output instead of attempting to reproduce inference.

## Lifetime and privacy

Controller disposal disconnects the local socket while leaving accepted output
available for another controller to read. An explicit Stop records interruption
before cancelling the server turn. Definitive account replacement clears local
HTTP turns, legs, capabilities and command metadata through the account privacy
transaction. Late frames and tool completions must still match the current
attempt, leg and responding turn; a replacement account cannot receive them.
Temporary identity availability failures preserve the observed account owner.

The raw read token is private local state, sent only in POST bodies. Diagnostic
transition payloads and verbose traces omit it, and the agent-context snapshot
does not include these collections. Remote erasure uses the separate privacy
retirement outbox/endpoint; clearing local capabilities alone is not a claim
that remote retained output has been deleted. The retirement receipt commits
only when HTTP succeeds and its body reports `retired`; a failed response can
be retried.

Legacy non-journal agent adapters keep their existing runtime path. A saved
HTTP turn reopened on a host without journal support is interrupted honestly;
it never silently downgrades to a new transient model request.

## Evidence

`HttpTurn.test.ts` exercises the active agent seat / `AppController` / `WebAgent`
composition, actual
local-storage close/reopen, more than 1,000 missed frames across multiple pages,
held persistence receipts, real commit failure, production command execution,
explicit retry identity and account replacement during a held tool batch.
`WebAgent.journal.test.ts` exercises the actual HTTP adapter's protocol decoding,
subscriber backpressure, disconnected sockets, existing heads, invalid cursors
and absence of silent legacy fallback. `AgentSeat.test.ts` checks awaited
commit delivery and backend ownership across recovery and chain binding.
Existing command, claim, retry and
account-boundary tests remain relevant to the shared primitives.
