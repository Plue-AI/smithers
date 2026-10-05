# Proof page

The proof page shows what the real app does, journey by journey, in the design
mock's order. It plays like `.specs/design/mock` but every frame is a recording
from the real bundle.

```
smthrs build //apps/app:proofRecord   # run e2e/proof/*.spec.ts on the real bundle; writes test-results/proof
smthrs build //apps/app:proofPage     # writes test-results/proof-page/index.html
open apps/app/test-results/proof-page/index.html
```

`bun apps/app/proof/page.ts --features <json> --results <json> --mock <json> --out <dir>`
runs the generator directly.

## Inputs

| Input | Default path |
| --- | --- |
| Feature registry | `.specs/product/features.json` |
| Playwright JSON results | `apps/app/test-results/proof/results.json` |
| Mock captions | `apps/app/proof/mock-steps.json`; when absent, the journeys in `.specs/design/mock/src/journeys` |

## Verdicts

Each feature gets one verdict from the recorded run:

| Verdict | When |
| --- | --- |
| Works | The feature names at least one proof step and every one passed. |
| Broken | A proof step, or a soft assertion inside it, recorded an error. The page shows the error. |
| Blocked by `<id>` | A proof step's error, or a test annotation of type `blocked`, says `blocked by <feature id>`. |
| Not built | The feature has no proof step, or the run never reached one of its steps. |

A mock step shows its worst feature, in the order Broken, Blocked, Not built,
Works. A step no feature covers is Not built.

A proof step is a `test.step` titled with the feature id (alone, or followed by
a space or a colon). Its screenshot is a test attachment named with the feature
id. A reel's video is the video attachment of the test in `e2e/proof/<reel>.spec.ts`.

`proofPage` exits 1 when `features.json` disagrees with the run: a feature is
`implemented` exactly when its verdict is Works. The page is written first, with
the disagreement at the top.

## The page

- One reel per mock journey; each feature is shown in full once, at the first
  mock step it covers. Features with no mock step open their journey's reel.
- Each feature links to its e2e test line, docs and code as GitHub permalinks at
  the recorded commit.
- Keys: Space plays or pauses, ← and → step, 1–9 pick a reel, T switches light
  and dark (the app's Paper palette).
- Screenshots are embedded; videos are files in `videos/` beside the page. The
  page makes no network request.

## The registry

`.specs/product/features.json` lists every feature, one entry each:

| Field | Meaning |
| --- | --- |
| `id` | Kebab-case and stable; the proof step and its screenshot use it. |
| `journey`, `spec` | `J1`..`J11` and the mvp.md section that defines it. |
| `mockSteps` | `<journey file>#<n>`, n 1-based, into `apps/app/proof/mock-steps.json`. |
| `status` | `implemented` only when every proof step passed in the latest recorded run; otherwise `not-implemented`. |
| `proof` | `{ file, step }`: a proof spec and the feature id of its `proofStep`. |
| `docs`, `code` | Docs pages and `path#La-Lb` code ranges on main. |
| `gap` | One line saying what fails or is missing. Required when not implemented; empty when implemented. |

```
smthrs test //apps/app:proofValidate          # validate the registry at HEAD
bun apps/app/proof/validate.ts --worktree     # the same checks on uncommitted edits
bun apps/app/proof/mock-steps.ts              # regenerate mock-steps.json after a mock edit
```

`proofValidate` fails on a schema error, a duplicate id, a mock step past its
journey's end, a proof file without its step id, a missing code, docs or spec
path, a line range past the end of its file, a missing or misplaced `gap`, an
implemented feature without proof, or a `mock-steps.json` that differs from the
design mock. It reads every path at HEAD through git, so it is never cached.

## Tests

| Test | Command |
| --- | --- |
| Verdict rules, links, fixture run, coverage property; registry schema, every validator failure, generated registries, the real registry | `bun test ./proof` from `apps/app` |
| Page e2e in Chromium | `bunx playwright test --config proof/test/playwright.page.config.ts` from `apps/app` |
| Re-record the fixture run | `bun proof/test/record-fixture.ts` from `apps/app` |
