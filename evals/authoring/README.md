# Authoring fine-tune

Assets and build targets for the Smithers workflow-authoring fine-tune on
Fireworks (Kimi K3). This directory holds the supervised fine-tuning (SFT)
dataset and declares the operations that validate, upload, and train on it as
first-class build-system targets, so none of them is a copy-paste shell command.

## Layout

| Path                   | What it is                                                     |
| ---------------------- | -------------------------------------------------------------- |
| `data/pilot-sft.jsonl` | The pilot SFT dataset: 10 OpenAI chat-format rows.             |
| `validate.ts`          | Dataset validator. Exit code is the verdict; no external deps. |
| `validate.test.ts`     | Regression tests for the validator's rejections.               |
| `PACKAGE.ts`           | The targets below.                                             |

## What the validator rejects

`firectl` uploads each row verbatim, so the gate refuses anything that must not
reach Fireworks or a trained model:

- a row or message that is not a JSON object;
- any top-level key besides `messages`, and any message key besides `role` and
  `content`;
- a row whose last turn is not `assistant`, or with no `user` turn before it;
- content with a host home path (`/Users/<name>`, `/home/<name>`,
  `C:\Users\<name>`, `~/`, `~<name>/`) or a
  credential shape (Fireworks, OpenAI-style, GitHub, AWS, Slack, private key).

Reference repository files by repo-relative path, such as
`examples/ralph-loop.jsx`.

## Targets

Deterministic, cache-eligible, and part of `ci`:

- `//evals/authoring:test` — proves every dataset row is a well-formed chat
  example. Run it with `pnpm exec smithers-build test
  '//evals/authoring:test'`.
- `//evals/authoring:validatorTest` — proves the validator rejects the rows it
  must.
- `//evals/authoring:check` — typechecks the validator.

Irreversible Fireworks operations. Each is a
[`ToolRun`](../../packages/smithers/build/docs/reference/targets/tool-run.md): never
cached, gated to the `run` verb so it can never enter a `ci` graph, and backed
by the `FIREWORKS_API_KEY` secret rather than a literal credential.

- `//evals/authoring:datasetUpload` — `firectl dataset create`. Depends on
  `test`, so a malformed dataset never reaches the account. Uploading
  a name that already exists fails, by design.
- `//evals/authoring:sftLaunch` — `firectl supervised-fine-tuning-job create`
  on `kimi-k3`. Every run starts a new billed job.

Run one explicitly, for example:

```
pnpm exec smithers-build run '//evals/authoring:sftLaunch'
```

## Prerequisites for the operations

The `firectl` CLI must be installed and signed in (`firectl signin`), and
`FIREWORKS_API_KEY` must be set in the environment. `firectl` refuses mutating
commands when it detects it is running inside an AI agent, so run the operation
targets from a human shell.

## Not yet here

The offline authoring benchmark harness (deterministic graders plus the
live-model runner) still lives at
`~/Desktop/fireworks-smithers-finetune/work/benchmark/harness`. It imports
`zod` and `typescript`, so wiring its suite as a `ci` target requires making
this directory a workspace package (a generated `pnpm-workspace.yaml` change and
an install), which is the follow-up to bring the benchmark under the graph.
