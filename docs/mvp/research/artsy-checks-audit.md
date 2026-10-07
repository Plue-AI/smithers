# Artsy AI-check references and compatibility

Read-only investigation completed 2026-09-16 by the delegated Artsy review agent. Neither application source nor Artsy source was changed. No model sessions or full Artsy package graphs were executed.

Smithers source links pin historical revisions. Artsy path citations refer to the sibling `../artsy` checkout inspected for this audit; the source examples themselves are not vendored into these docs. The findings and executed-check record below are preserved here so the audit does not depend on an ignored scratch directory.

## Reusable examples

- Honcho telemetry registry rule (`../../../../artsy/honcho/workflows/lints/telemetry-registry.md:1`): missing event registrations, unbounded labels, replica-unsafe gauges, incorrect gauge aggregation, and telemetry failures escaping into product work. Declaration (`../../../../artsy/honcho/PACKAGE.ts:117`), quality/prePush/CI composition (`../../../../artsy/honcho/PACKAGE.ts:242`), approved issue flow (`../../../../artsy/honcho/workflows/approved-issue/PACKAGE.ts:20`).
- Shade Tree log hygiene rule (`../../../../artsy/shade-tree-node/workflows/lints/log-hygiene.md:7`): semantic privacy violations beyond deterministic secret scanning. Its fixes must preserve the useful diagnostic signal. Declaration (`../../../../artsy/shade-tree-node/PACKAGE.ts:268`), prePush (`../../../../artsy/shade-tree-node/PACKAGE.ts:383`), implementation loop (`../../../../artsy/shade-tree-node/workflows/ship-roadmap/PACKAGE.ts:129`).
- Cheap checks first (`../../../../artsy/shade-tree-node/workflows/lints/cheap-checks-first.md:21`): identify expensive verification that precedes a valid cheap rejection, with offending input and legitimate exceptions.

The reusable format is a narrow rule, concrete violations and exceptions, scoped input/context, structured findings, and configured consequences. A generic score is insufficient.

## Executed checks

| Check | Observed result | Scope of evidence |
| --- | --- | --- |
| Three actual Artsy S.Agent.Lint declarations instantiated and decoded with current @smthrs/targets | Passed on Node 24.18; each plans one smithers-build/agent-lint check action | API and planning compatibility |
| build-cli AgentSession.test.ts filtered to Agent.Lint | 10 passed; 91 unrelated tests skipped | Empty-diff behavior, blocking/advisory findings, cache invalidation, bounded fix enforcement; scripted model responses |
| targets AgentTarget.test.ts | 14 passed | Declarations, schemas, action payloads |
| Shade Tree node lib/log.selftest.mjs | 30 assertions passed | Logger formatting, routing, context, redaction, serialization |
| Honcho node workflows/gates/sdk-version-parity.mjs | Passed; version 2.4.0 | Deterministic gate execution |

The Honcho telemetry tests (`../../../../artsy/honcho/tests/telemetry/test_metric_zero_init.py:74`) were inspected, not executed; the checkout has no Python virtual environment. No live model-backed rubric eval was run. These results do not establish the prompts' real-world precision or recall.

Installed Bun 1.4.0 canary could not directly import current targets because it lacks node:util.getCallSites. The supported Node probe passed. This is a runtime compatibility limit for the inspected environment, not an obsolete S.Agent.Lint API: the current wrapper is Action.make-backed ([source](https://github.com/smithersai/smithers/blob/98c873ef2dea5f385e3daacdb666eba36e523882/packages/smithers/build/targets/src/AgentTarget.ts#L656)).

## Required adaptations

1. **Actual PR diff.** The declarations omit a base, and gitDiff defaults to HEAD ([source](https://github.com/smithersai/smithers/blob/955f8176943f3526b1adb5a7808ac0cd9537568d/packages/smithers/build/targets/src/Input.ts#L195)). Execution compares the working tree against that base ([source](https://github.com/smithersai/smithers/blob/a6aeda00da7c5c20beaf8236f4b6e40f5924d32f/packages/smithers/build/build-cli/src/AgentSession.ts#L748)). A clean committed PR can therefore receive no review. Bind the appropriate PR comparison/candidate and test that case.
2. **Call-site coverage.** Honcho scopes its rule to src/telemetry/** and tests/telemetry/**. An observability requirement for new handlers must also inspect those handlers and jobs.
3. **Explicit context.** The review session has no tools ([source](https://github.com/smithersai/smithers/blob/a6aeda00da7c5c20beaf8236f4b6e40f5924d32f/packages/smithers/build/build-cli/src/AgentSession.ts#L1431)). Supply relevant source, registries, helpers, conventions, and evidence; don't assume the model can explore the repository.
4. **Independent final verdict.** Current check mode ([source](https://github.com/smithersai/smithers/blob/a6aeda00da7c5c20beaf8236f4b6e40f5924d32f/packages/smithers/build/build-cli/src/AgentSession.ts#L1579)) blocks warning/error findings and preserves informational findings. A product-level report/required policy must be explicit. After repair, rerun the check against the resulting code instead of accepting the repair model's own remaining-findings claim.
5. **Rubric evals.** Cover violations, compliant code, legitimate exceptions, unrelated changes, omitted instrumentation outside the telemetry module, clean committed PRs, malformed output, insufficient context, and model failure.

## Migrate instead of copying

- agent-session-search observability prompt (`../../../../artsy/agent-session-search/.smithers/prompts/sweep-observability.mdx:1`) has useful concerns but edits code and awards itself a score. Its audit wrapper (`../../../../artsy/agent-session-search/.smithers/workflows/audit.tsx:6`) uses obsolete createSmithers/JSX authoring.
- smithers-samples dependencies (`../../../../artsy/smithers-samples/package.json:10`) contain absolute paths to removed package locations. Fresh-looking syntax is not proof of a runnable package.
