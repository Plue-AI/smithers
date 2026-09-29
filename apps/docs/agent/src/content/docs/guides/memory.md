---
title: "Give a run memory"
description: "Bind the memory flow, open a run with the context it selects, and read how Jev chooses wiki pages, code, commits and facts under a byte budget without breaking the prompt cache."
sidebar:
  order: 13
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/guides/memory.md"
---

`memory` is one ordinary sealed flow. A cell calls it like any capability:

```js
const m = await ctx.call("memory", { task: "Retry the wiki citation check when Jev times out" })
console.log(m.context)
```

It returns `{ context, digest, kept, omitted, cost }`. `context` is one fenced
block of at most `maxBytes` (32 KiB by default, 64 KiB at most). `kept` and
`omitted` name each candidate with Jev's probability and what decided it:
`seed`, `jev`, `budget` or `stale`. A file past 64 per directory or 256 in all
is never read or asked; it is omitted as `budget` with `bytes` 0.

## Bind it

A host binds memory through the plugin hook and opens each run with the same
selection:

```ts
import * as Memory from "@smthrs/agent/Memory"

const services = Context.add(platformServices, Evaluator.Evaluator, judge)
const opened = yield* Memory.opening(task, { root })

agent.run({
  prompt: task,
  memory: opened.memory, // frame 0, as Agent.Options.memory rows
  plugins: [Memory.plugin(services, { root })], // ctx.call("memory", …)
  // …
})
```

`services` provides `FileSystem`, `Path`, `ChildProcessSpawner` and the
`Evaluator`. `opening` packs to 16 KiB. The run-start relevance reading may
still withhold any opening row at `Relevance.withholdAt`, like any memory row.

## What it reads

| Source  | Candidates                                                                                                                  | Jev question                       | Threshold        |
| ------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------- |
| Seeds   | Paths (with `repo`) and commit ids (with `commits`) the task or `paths` name                                                | none, kept                         |                  |
| Wiki    | Pages in `.smithers/coding-project.json`, `factory/wiki/decisions/*.md`, `.agents/skills/*/SKILL.md`, `.flows/wiki/deps/**` | `memory/needed`, top 30 by keyword | 0.35; deps 0.50  |
| Repo    | A README walk: 4 levels, 64 children judged and 8 kept per directory, 48 directories; then the files of kept directories    | `memory/descend`, `memory/needed`  | 0.30, 0.35       |
| Commits | `jj log` of the kept and seeded files, 60 at most, with `refs/notes/mythical` notes                                         | `memory/needed`                    | 0.50             |
| Facts   | Rows of the named banks from `@smthrs/memory`                                                                               | `relevance/unnecessary`            | withheld at 0.90 |

A directory is shown to Jev as its README head (300 bytes) and its entry
names; a directory without a README is judged by its entry names alone.
`AGENTS.md` and `CLAUDE.md` are never candidates: every harness reads them
itself. A root below a jj workspace root reads only its own tracked files.
Outside jj, a git repository lists only the files git tracks, so an ignored or
untracked file is never a candidate; a filesystem walk runs only when neither
jj nor git answers. Links, `.env` files, `Smithers-Ops/`, `.flows/` and
`node_modules/` are never read, whether walked, seeded or named by a catalog
page, and neither is a seed, catalog document or skill that resolves outside
the root through a linked parent directory. A file or walked directory the host
will not let memory read is skipped like an absent one.

## Budget and cache

The block orders seeds, facts, pages, files, then commits, and gives each group
a fair share of the remaining bytes. An item that does not fit whole keeps its
head and says so, in the block and in its frame-0 row. Repository text is
data: fence tokens and item labels inside it, and in item ids, are escaped.

A mid-run call's result enters the append-only tail and a frame-0 block enters
the opening prefix, so no request's prefix or `cacheKey` changes after the call.
The flow is `sealed`: a call after an edit is re-keyed by the tree, and a
resumed run replays the recorded block without asking Jev.

## When Jev fails

A Jev that is unavailable (unreachable, slow, or refusing with a 429 or a 5xx,
the rule `EvaluatorBackup.withFallback` falls back by), or a host with no judge
(reason `unconfigured`), returns the seeds and the recalled facts with
`unjudged` set; the run-start relevance reading still judges each fact row. A
bound plugin journals a `decision-unjudged` row naming the classifier and item
count of the reading that failed, and `opening` returns it for the host to log.
Any other Jev failure fails the call with `MemoryFailed` code `judge_failed`.

## Thresholds

Each decision has a threshold `τ = extra / (miss + extra)` from declared costs:
a missed file costs more than an extra one, so files are included at 0.35. A
repository's own fit, `.smithers/memory-thresholds.json`, replaces the
defaults: `select` reads it when `Options.thresholds` is absent, and
`Memory.source` binds it, so its digest joins the step key. A file that does
not decode fails as `thresholds_invalid`. See
[`MemoryCalibration`](/reference/api/#memorycalibration). A fit never moves a
threshold more than 0.05 at once and needs 200 labels.
