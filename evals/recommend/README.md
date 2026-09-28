# The command-recommender eval

A scorer for the recommendation pills under the composer. Every time the
server asks Jev for a recommendation it logs one row: the ordered list of
commands it offered, and, once the user runs something, the command they ran
next. This suite turns that log into three numbers.

## Running it

From the repository root:

```bash
bun evals/recommend/run.ts
```

That scores the checked-in fixture `fixtures/sample.jsonl` and gates the
result on `baseline.json`. It is offline and deterministic, so it is the CI
run, and a red run means the scorer moved, not the model.

| Flag                   | Effect                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `--input <file.jsonl>` | Scores an exported log and prints the table. No baseline is consulted.                   |
| `--live`               | Pulls the log from a deployment's admin route, scores it, and prints the table.          |
| `--update`             | Rewrites `baseline.json` from the fixture. Only when the scorer changed on purpose.       |
| `--json`               | Prints the score as canonical JSON instead of the table.                                 |
| `--help`               | Prints usage and exits 0.                                                                |

stdout carries the score and nothing else: one table, or under `--json` one
JSON value, in every mode. Verdicts and recorded paths are diagnostics and go
to stderr, so `bun evals/recommend/run.ts --json | jq` parses whichever mode
produced it.

Exit codes: `0` scored, or the fixture matched the baseline; `1` the fixture's
score disagrees with the baseline; `2` the input could not be read or parsed;
`3` the live pull failed.

### The live pull

`--live` reads two environment variables and prints neither:

| Variable               | Meaning                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `SMITHERS_ORIGIN`      | The deployment to read. Default `https://smithers.sh`.                     |
| `SMITHERS_ADMIN_TOKEN` | The bearer the deployment's `/api/admin/*` routes accept. Required.       |

It sends `GET <origin>/api/admin/recommend/log?limit=2000` with
`authorization: Bearer <token>` and scores the `rows` array the route answers
with, newest first. A refused or malformed answer is reported with its status
and exits `3`; the token is never echoed, not even in that message.

The pull guards the bearer and the operator's terminal:

- `SMITHERS_ORIGIN` must be `https://`, or `http://` on `localhost`,
  `127.0.0.1`, or `[::1]`. Any other origin exits `3` before the request.
- Redirects are not followed, so the bearer never reaches a second host.
- A body over 16 MiB, or more than 2000 rows, exits `3`.
- Repository and model names, log values quoted in error messages, and the
  parse error for a non-JSON body print with control characters escaped as
  `\xNN`, so neither a log row nor the origin can inject
  terminal escape sequences. `--json` output also escapes U+007F to U+009F
  as `\u00NN`.

```bash
SMITHERS_ORIGIN=https://canary.smithers.sh SMITHERS_ADMIN_TOKEN=... bun evals/recommend/run.ts --live
```

## What it measures

Each log row is one recommendation:

```json
{ "id": "rec_0001", "at": "2026-09-06T09:00:00.000Z", "repo": "smithersai/smithers",
  "tailDigest": "<sha256 of the chat tail>", "commandCount": 41,
  "commands": ["flow.list", "repo.open", "runs.list", "issues.view", "review.run"],
  "model": "gpt-oss-120b",
  "outcome": { "command": "flow.list", "at": "2026-09-06T09:00:42.000Z" } }
```

`commands` is the list the user saw, best first, at most five entries.
`outcome` is what they ran next, or `null` while nobody has acted on the
recommendation. The tail itself is never logged; only its digest is, so the
log can be exported without exporting anyone's chat.

Three numbers, each reported overall and per repository:

| Metric     | Definition                                                          | Reads as                                                          |
| ---------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `hit@5`    | Rows with an outcome whose next command is anywhere in `commands`.  | Did the pills contain what the user wanted? `k` is the list cap.  |
| `top-1`    | Rows with an outcome whose next command is `commands[0]`.           | Was the first pill the right one?                                 |
| `coverage` | Rows with an outcome, over all rows.                                | How much of the log the two rates are computed from.              |

`hit@5` and `top-1` are rates over the rows that have an outcome. A row
without one is a recommendation the user has not acted on yet; it lowers
coverage and touches neither rate. A row whose `commands` is empty (the server
had no honest list to offer) can only miss.

Rates whose denominator is zero are `null` in the JSON and `n/a` in the table,
so an empty log reads as empty rather than as 0%.

### Reading the table

```
recommend eval: 16 rows, 13 with an outcome

bucket                    rows    outcome   coverage      hit@5      top-1
overall                     16         13      81.3%      69.2%      38.5%
acme/widgets                 5          3      60.0%      66.7%      33.3%
smithersai/smithers          8          7      87.5%      71.4%      42.9%
(no repo)                    3          3     100.0%      66.7%      33.3%
```

Read `coverage` first: a rate over three outcomes is an anecdote. Then
`hit@5`: below it, the model is not offering what people run and the prompt
or the command summaries need work. Then `top-1`: the gap between it and
`hit@5` is ordering, which is the cheapest thing to improve. Repositories
with `repo: null` are signed-out or pre-selection chats and are scored as
`(no repo)`.

The fixture is synthetic. Its numbers prove the scorer, not the recommender;
the recommender's numbers come from `--live` or `--input` on an exported log.

## Files

| File                    | What it is                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| `score.ts`              | The pure half: the row contract, the JSON-lines parser, the scorer, the table.   |
| `run.ts`                | The entry point: the three modes, the baseline gate, the exit codes.             |
| `score.test.ts`         | Behaviour tests for the scorer, parser, and renderer.                            |
| `run.test.ts`           | Behaviour tests for the program: every mode, the fixture, and the baseline.      |
| `fixtures/sample.jsonl` | Sixteen synthetic rows over three repositories covering a top-1 hit, a lower hit, a miss, an empty list, and pending rows. |
| `baseline.json`         | The fixture's score in canonical JSON. Regenerated by `--update`; do not reformat. |
| `tsconfig.json`         | Typechecks the suite: `tsc -p evals/recommend`.                                  |

## Updating the baseline

```bash
bun evals/recommend/run.ts --update
```

Do this only when the scorer or the fixture changed for a reason you can name
in the commit message. `run.test.ts` also compares the fixture's score with the
baseline, so both gates move together.
