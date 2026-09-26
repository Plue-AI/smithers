---
title: "Installation"
description: "Add @smthrs/evals to a workspace package, plus its runtime requirements and entry points."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/evals/docs/installation.md"
---

The package is at 1.0.0-rc.0 and is not on the npm registry yet. It is a
workspace package of https://github.com/smithersai/smithers, so use it from a
package in a clone of that repository:

```bash
git clone https://github.com/smithersai/smithers
cd smithers
pnpm install
```

Then depend on it through the workspace protocol in your package's
`package.json` and run `pnpm install` again:

```json
{
  "dependencies": {
    "@smthrs/evals": "workspace:*"
  }
}
```

## Runtime requirements

- Node.js 26.4.0 or later, from the package's `engines` field.
- `effect` 4.0.0-rc.115. Suites, runs, baselines, and gates are all `Effect`
  values, so every program composes with the `effect` library directly.
- `@smthrs/core` supplies `Flow` values. `@smthrs/scorers` supplies scorers,
  bindings, and the pure `@smthrs/scorers/ScoreGate` grading contract, including
  `ScoreGateError`. The evaluation runtime does not load `@smthrs/testing`;
  that package supplies a test facade for development consumers. To run the
  agent behind a case, add [@smthrs/agent](https://agent.smithers.sh/reference/api/) as well.

## Entry points

- `@smthrs/evals` exports the nine namespaces: `EvalError`, `Suite`,
  `CaseExecutor`, `Runner`, `Baseline`, `Regression`, `Report`, `Gate`, and
  `Trials`.
- `@smthrs/evals/<Module>` imports one namespace directly, for example
  `@smthrs/evals/Suite`.
- `@smthrs/evals/package.json` is exported. The `internal/*` modules and
  nested `*/index` subpaths are not public.
