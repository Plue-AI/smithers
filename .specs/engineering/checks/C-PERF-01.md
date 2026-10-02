# C-PERF-01 App agent first token < 1.5 s; answer with cards < 8 s

Proves: mvp.md §9 App agent, §6.5 Context preflight · spec.md §8.2.1, §11.5a, §15.1.1, §15.1.2, §18 · Layer: perf · Stage: R · Tickets: T-REL-01
Automation: `scripts/perf/agent-first-token.mjs` (new) · Runs in: reference host plus a second Mac on the same network

## Setup
- Install at commit X on the reference host (the team's Mac mini, whatever its size); setup done through Source ready; no machine awake, and the run must not wake one.
- The app agent and its preflight run on the `fast` role (§11.5a) as the owner set it in Settings; record provider and model id, and the `coding` model in case of fallback.
- `scripts/perf/questions.json` (new): 20 fixed questions about the scratch repository's code and wiki that need no machine.
- Playwright Chromium on the second Mac B, signed in as a member, reaching the install through its configured public origin (record which origin and scheme).

## Steps
1. Warm up with 5 questions; discard them.
2. For i in 1..100 (each question 5 times, shuffled), as a new prompt in `main`'s conversation (§14.1), with the context preflight running as usual (§15.1.2):
   - t0 = `performance.now()` at the Enter keydown in the composer, the moment of submit;
   - t1 = the first answer token rendered in the DOM (MutationObserver);
   - t2 = the answer complete with at least one file or wiki card rendered.
3. For each sample, read the turn's preflight step from its Inspect events: its start and end on the host clock, and its model.
4. Read `/api/install/metrics` for the same window as a cross-check.
5. Read the `home` topic's machines count before and after.

## Pass when
- n = 100 valid samples; nearest-rank p95(t1 − t0) < 1.5 s and p95(t2 − t0) < 8 s. Both clocks start at submit, so preflight is inside both.
- Preflight duration (step 3) is reported separately with its p50 and p95, and never subtracted from t1 − t0 or t2 − t0.
- Every answer contains at least one card, and every turn records a preflight step with a `context[]` list.
- Zero machine wakes during the run.
- Clock: B's browser monotonic clock for t0, t1 and t2 of a sample, from the same page.

## Fail when
- The clock starts at the answer step, or after preflight, instead of at submit.
- First token measured from the network frame instead of the rendered DOM.
- Preflight is skipped or cached across samples, so the timing omits the step every real turn runs first.
- Answers without cards, failed answers or retries are dropped from the sample instead of failing it.
- A question wakes a machine, so the answer path is not the no-machine path.

## Evidence
`.artifacts/perf/<date>/agent-first-token.json` (raw samples with t0, t1, t2 and preflight duration, summary, the models used, the detected host profile (§8.2.1), origin, browser version, commit, install version) and a copy with `summary.json` in `.artifacts/checks/C-PERF-01/<UTC timestamp>/`.
