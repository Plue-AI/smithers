import { Workflow, Task, Parallel, on } from "@smithers-ai/workflow";

// Cloud discovers this file and runs each task in an independent Linux sandbox.
// Workspace includes package typechecks, tests, lint and docs. See cloud.sh for
// tool bootstrap and the gates excluded from this Linux, credential-free lane.
//
// Cloud schedules these tasks on a pool of at most 5 small gVisor runners, and
// a fresh sandbox re-runs the JS bootstrap (npm + pnpm + `pnpm install
// --frozen-lockfile`) every time, about 11 minutes before any gate starts. One
// task per gate cost 39 x ~12 minutes over 5 runners, so 1.5-2 hours per push:
// run 11697 (2026-09-15) still had 35 gates queued after 20 minutes.
//
// So the gates (46 as of 2026-09-23) are batched into 6 tasks that each bootstrap once and then
// run their gates in order (`cloud.sh group ...` prints `::gate <name>
// start|ok|fail` per gate, runs them all even when one fails, and exits
// non-zero if any did). Groups share a toolchain so the extra installs are
// paid once as well, and are sized for similar wall-clock time:
//
//   packages  jj + Foundry, the slowest suites
//   rust      the only Rust toolchain install
//   ui        the browser and app gates, on jj
//   apps      per-app ci lanes and docs/site builds
//   evals     the offline eval/check pairs
//   checks    JS-only lint, drift and contract gates
//
// SMITHERS_CLOUD_CI=1 tells cloud.sh it is on a Cloud runner rather than a
// developer's machine, which is what lets a gate that cannot run on this tier
// print `::gate <name> skipped (<reason>)` instead of failing, while the same
// gate still runs for anyone reproducing it locally.
//
// scripts/ci/cloud.test.ts asserts these groups partition cloud.sh's gates:
// every gate appears in exactly one task, and no task names a missing gate.
export default () => (
  <Workflow name="CI" triggers={[on.push({ branches: ["main"] }), on.manualDispatch({})]}>
    <Parallel>
      <Task id="packages" secrets={[]}>{`SMITHERS_CLOUD_CI=1 bash scripts/ci/cloud.sh group workspace packages faults`}</Task>
      <Task id="rust" secrets={[]}>{`SMITHERS_CLOUD_CI=1 bash scripts/ci/cloud.sh group rust-lint wasm-build-script third-party-notices rust-test native-ffi tui backend-go scripts`}</Task>
      <Task id="ui" secrets={[]}>{`SMITHERS_CLOUD_CI=1 bash scripts/ci/cloud.sh group ui-check ui-tests ui-conformance examples factory-harness ui-browser`}</Task>
      <Task id="apps" secrets={[]}>{`SMITHERS_CLOUD_CI=1 bash scripts/ci/cloud.sh group flows flows-egress flows-repository flows-fixtures flows-product-host bug-worker review-app docs site server`}</Task>
      <Task id="evals" secrets={[]}>{`SMITHERS_CLOUD_CI=1 bash scripts/ci/cloud.sh group agent-check authoring-check swebench-check review-check recommend-check agent-eval authoring-eval review-eval recommend-eval swebench`}</Task>
      <Task id="checks" secrets={[]}>{`SMITHERS_CLOUD_CI=1 bash scripts/ci/cloud.sh group script-lint flows-lint swebench-lint jsdoc-rules jsdoc project-copy target-index factory-drift workflow-drift web-bundle cloud-contract`}</Task>
    </Parallel>
  </Workflow>
);
