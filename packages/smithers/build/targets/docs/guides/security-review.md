---
title: "Security review"
description: "S.SecurityReview declares a package's security checks once and yields a cheap diff review and a manual full audit."
sidebar:
  order: 6
---

`S.SecurityReview` turns a package's security checks into two `LlmLint`
targets. Spread the result into the package's targets:

```ts
import { Smithers as S } from "@smthrs/targets"

const securityReview = S.SecurityReview({
  cwd: "packages/uploads",
  checks: [{
    id: "upload-path-traversal",
    title: "Upload paths stay inside the upload root",
    threat: "An authenticated user writes files outside their own upload directory.",
    lookFor: [
      "A request-supplied file name joined to the root without normalizing and prefix-checking it.",
      "A symlink inside the root followed on write."
    ],
    paths: ["src/upload/**"]
  }]
})

export const Package = S.Package({ targets: { ...securityReview } })
```

| Target          | Reviews                               | Selected by                                         |
| --------------- | ------------------------------------- | --------------------------------------------------- |
| `security`      | included files changed against `base` | `smithers-build review '//...'` and any label       |
| `securityAudit` | every included file, changed or not   | a label or `//pkg/...:securityAudit`, never `//...` |

Run a full audit of a package and every nested package with:

```sh
smithers-build review '//packages/uploads/...:securityAudit' --verbose
```

## Checks

Each check has a kebab-case `id`, a one-line `title`, a `threat` naming who
could do what to whose data, a `lookFor` list of concrete, falsifiable things to
inspect, and optional `paths`, package-relative globs the check focuses on. The
macro always appends the built-in `general` check, which sweeps for injection,
authorization gaps, secrets, path traversal, SSRF, unsafe deserialization,
command execution, crypto misuse, prompt injection, supply chain, denial of
service, and information leaks. The id `general` is reserved.

## Findings

Every finding names one check id and reads
`[<check id>] <confirmed|suspected>: <who> can <do what> to <whose data> because <cause>. Fix: <fix>.`
Severity `error` is a confirmed flaw and fails the target. `warning` is a
suspected flaw and `info` is hardening; both are printed without failing it.
The prompt frames the run as an authorized defensive review by the repository
owner and asks for the flaw and the fix, never an exploit.

## Options

| Option           | Default           | Meaning                                                       |
| ---------------- | ----------------- | ------------------------------------------------------------- |
| `cwd`            | required          | Workspace-relative package directory.                         |
| `checks`         | required          | The package's checks; `[]` leaves only `general`.             |
| `include`        | `["src/**"]`      | Reviewed files; strings or `S.glob`, `//` for workspace root. |
| `context`        | `[]`              | Files read into every batch whether or not they changed.      |
| `engine`         | `"claude"`        | `claude` or `codex`.                                          |
| `model`          | `claude-opus-5-5` | `gpt-6-sol` when `engine` is `codex`.                         |
| `base`           | `"origin/main"`   | The diff review's base revision.                              |
| `batchSize`      | `4`               | Files per model call in `security`.                           |
| `auditBatchSize` | `8`               | Files per model call in `securityAudit`.                      |
| `deps`           | `[]`              | Targets that must run first.                                  |
| `summary`        | generated         | One-line summary of `security`.                               |

A review makes at most 64 model calls, so the audit covers at most
`64 * auditBatchSize` files. Narrow `include` or raise `auditBatchSize` for a
larger package.

## Cost and CI

The aggregate `ci` verb never plans a review. The `review` verb plans
`security`, which reads only changed files. `securityAudit` is manual: a bare
wildcard skips it, so it runs only when someone names it. A host without the
engine CLI reports the review as skipped, not failed.
