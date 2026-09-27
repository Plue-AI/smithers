---
title: "smthrs plan"
description: "Render a flow plan and its complete approval payload"
area: cli
order: 0
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/reference/cli/plan.md"
---

## Synopsis

```text
smthrs plan FLOW_ID [KEY=VALUE ...] [--data JSON]
```

## Description

`smthrs plan` asks the control plane to plan one flow with one input, then
prints the plan card it returns. The card carries the plan id, the content
digest, a canonical summary of the input, the capability envelope, the keyed
node graph, and the `approval` payload that `smthrs approve` and
`smthrs run` accept unchanged.

The command creates no run, grants no approval, and executes no node. A durable
run row appears only when `smthrs run` or `smthrs up` submits the payload.

A flow id that starts with `system/` is refused. The control catalog reserves
those ids for command-line verbs and 1.0.0-rc.0 ships a body for none of them,
so a launch would park with nothing to run.

## Arguments

Omitting `FLOW_ID` with terminal stdin opens the flow picker. With piped stdin,
the command exits 2 and names `flow-id` and `--wizard` for guided input.

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `FLOW_ID` | `string` | Yes | The flow to plan, spelled as `smthrs ls` lists it. |
| `KEY=VALUE` | `string` | No | One input entry, repeatable. The text before the first `=` is the key and the text after it is the value. An element with no `=` becomes that key with the boolean value `true`. |

## Flags

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--data` | `string` | None | A JSON document merged over the `KEY=VALUE` entries. A JSON object contributes its own members; any other JSON value lands under the key `data`. |

## Global flags

`smthrs plan` accepts `--root`, `--remote`, `--json`, `--quiet`,
`--mcp-config`, and `--log-level`, listed in the
[CLI reference index](https://smithers.sh/docs/reference/cli/). It reads the bearer from `SMITHERS_API_KEY`.
`--credential` is a compatibility flag that warns on stderr because process listings and shell history expose its value.

## Output

`smthrs plan` prints one JSON document on stdout. Object members are ordered
by UTF-16 code unit, the human rendering indents two spaces per level, and
`--json` prints the same document with no whitespace.

The document's members are `approval`, `deployClass`, `digest`, `envelope`,
`flowId`, `inputSummary`, `nodes`, `planId`, and `plan` when the host handed a
persisted plan to the card. `inputSummary` is the RFC 8785 canonical JSON of
the decoded input. `envelope` holds `capabilities`, `flows`, `budget`, and
`host` when the plan places the run. `approval` holds `target`, `scope`, and
`idempotencyKey`; `scope` is `run`, and `idempotencyKey` is `approve:` followed
by the plan id, because the command line supplies none of its own.

`--quiet` suppresses banners and progress on stderr, but this document still
prints.

Notices go to stderr before the document. Unused legacy PostgreSQL options
and test-only connection strings are reported. `SMITHERS_POSTGRES_URL`,
`DATABASE_URL`, and `SMITHERS_POSTGRES_SCHEMA` configure the selected store.
A project holding 0.x state receives the notice from `Project.legacyNotice`.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The plan card was rendered. |
| `1` | The flow id names a reserved `system/` flow, `--backend` or `SMITHERS_BACKEND` names a backend other than `sqlite` or `postgres`, the control plane refused the plan (flow not found, invalid input, persistence failure, unavailable), or the document exceeded a rendering bound. |
| `2` | `--data` is not valid JSON, or the command line failed to parse. |
| `130` | The process received `SIGINT`, or the command was interrupted. |
| `143` | The process received `SIGTERM`. |

## Example

Plan the `deploy/status` flow with one input entry:

```bash
smthrs plan deploy/status branch=main
```

The human rendering, with placeholders standing in for the identifiers:

```text
{
  "approval": {
    "idempotencyKey": "<idempotency-key>",
    "scope": "run",
    "target": {
      "_tag": "Plan",
      "digest": "<digest>",
      "envelope": {
        "budget": {},
        "capabilities": [],
        "flows": []
      },
      "planId": "<plan-id>"
    }
  },
  "deployClass": false,
  "digest": "<digest>",
  "envelope": {
    "budget": {},
    "capabilities": [],
    "flows": []
  },
  "flowId": "deploy/status",
  "inputSummary": "{\"branch\":\"main\"}",
  "nodes": [],
  "planId": "<plan-id>"
}
```

## See also

- [`smthrs approve`](https://smithers.sh/docs/reference/cli/approve/) grants the `approval`
  payload this command prints.
- [`smthrs run`](https://smithers.sh/docs/reference/cli/run/) submits that payload as a run.
- [`smthrs up`](https://smithers.sh/docs/reference/cli/up/) performs plan, approve, and run in
  one call.
- [`smthrs ls`](https://smithers.sh/docs/reference/cli/ls/) lists the flow ids this command
  accepts.
- [Plan, approve, run](https://smithers.sh/docs/guides/plan-approve-run/) shows the procedure.
