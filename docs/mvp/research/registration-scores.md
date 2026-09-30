# Slop score and agent-readiness score: research and design (2026-09-26)

## 1. What exists

| Approach | Examples | Accuracy | Cost | Per repo? | License |
|---|---|---|---|---|---|
| Trained classifiers | [GPTSniffer](https://arxiv.org/pdf/2307.09381), [CodeGPTSensor](https://dl.acm.org/doi/10.1145/3705300), [Droid](https://arxiv.org/pdf/2507.10583) | High in-distribution; [AICD Bench](https://arxiv.org/html/2602.02079v1) (2M samples, 77 models): macro-F1 0.63 seen → **0.21** unseen domain+language; hybrid code misread as fully AI | GPU/CPU inference, cheap | Per snippet | Research code, mostly MIT/Apache; datasets vary |
| Zero-shot perplexity | [DetectGPT4Code](https://arxiv.org/abs/2310.05103), [DetectCodeGPT](https://arxiv.org/pdf/2401.06461) (whitespace perturbation, ICSE 2025) | AUROC ~0.83 avg, 0.67 at temp 1.0 | Needs white-box surrogate LM + many perturbations | Per snippet | [MIT](https://github.com/YerbaPage/DetectCodeGPT) |
| Commercial | Copyleaks code, GPTZero code beta | Unpublished for code; [Codequiry test](https://codequiry.com/blog/ai-code-detector-comparison-across-codequiry-gptzero-and-copyleaks) found crashes and over-flagging of long Javadoc | Per-call fees | Per file | Proprietary; would send customer code out |
| Watermarking | [SWEET](https://arxiv.org/abs/2305.15060), [MCGMark](https://arxiv.org/pdf/2408.01354) | Good only when the vendor embeds it | n/a | n/a | No major coding model ships one; unusable |
| Provenance traces | [Agentic Much?](https://arxiv.org/html/2601.18341v1): `Co-authored-by` trailers, `CLAUDE.md`/`AGENTS.md`/`.cursor`, `copilot/` branches, PR labels; [AIDev](https://arxiv.org/pdf/2602.09185) (933k agent PRs) | Precise but a floor: 15.9–22.6% of 129k projects adopt agents; file vs commit markers correlate ≤0.1 | Free (git log) | Yes | n/a |
| Slop linters | [antislop](https://github.com/skew202/antislop) (MIT/Apache, 18 langs: placeholders, "for now", hedging, stubs, noise comments), [ai-slop-detector](https://github.com/flamehaven01/ai-slop-detector) (27 "fake-done" checks), [sloppylint](https://github.com/rsionnach/sloppylint) (Python), [slop-linter](https://github.com/almcc/slop-linter) (uses Jev) | Unvalidated; quality, not authorship | Seconds | Yes | Open source |
| Repo process metrics | [slop-o-meter](https://slop-o-meter.dev/) (code growth vs human attention; authors call it "unreliable"), [GitClear](https://www.gitclear.com/ai_assistant_code_quality_2025_research) (clone blocks 8x in 2024, 2-week churn 3.3% → 7.1%) | Population-level, not per-repo proof | Cheap | Yes | GitClear proprietary; metrics are reproducible |

Findings:
- **Nobody can reliably say a given file was AI-written.** Detectors collapse on new models, domains, hybrid edits and paraphrase ([AICD Bench](https://arxiv.org/html/2602.02079v1), [DIMVA 2025](https://ldklab.github.io/assets/papers/dimva25-aicode.pdf)). Claiming authorship would be wrong and insulting.
- **Provenance is precise but incomplete**: absence proves nothing.
- **Quality signals that correlate with AI use are measurable and actionable**: clones, short-term churn, placeholders, stubs, redundant docstrings, dead code. AI code clusters in glue, tests, docs and boilerplate ([AI Code in the Wild](https://arxiv.org/pdf/2512.18567)).

So **split the question**: (a) *agent-written share* (evidence floor plus estimate) and (b) *cleanup opportunities* (quality, whoever wrote it). The headline slop score is (b); (a) sits beside it.

## 2. Smithers slop score (0–100, lower is cleaner)

### Signals and weights

| # | Signal | Kind | Weight |
|---|---|---|---|
| S1 | Duplicated blocks ≥6 lines per KLOC (jscpd, MIT; tree-sitter normalized) | Deterministic | 15 |
| S2 | Two-week churn: share of lines added in the last 180 days that were rewritten or deleted within 14 days (`git log -p`/blame) | Deterministic | 10 |
| S3 | Slop lexicon: placeholders, "for now", "should work", "In a real implementation", emoji or "✅" in code comments, and narrating comments ("// Increment i"). antislop rules plus our own list | Deterministic | 10 |
| S4 | Stubs and fake-done code: empty bodies, `pass`/`throw new Error("not implemented")`, `return true // TODO`, `catch {}` swallow | Deterministic | 10 |
| S5 | Dead code: unused exports/files/deps (knip, ts-prune, vulture, `go vet`/staticcheck U1000) | Deterministic | 10 |
| S6 | Comment and docstring redundancy: comment-to-code ratio outliers, plus docstrings that restate the signature | Hybrid: ratio is deterministic; restating is judged by Jev on a sample | 10 |
| S7 | Over-defensive code: redundant null checks on typed non-null values, try/catch-log-rethrow, validation repeated at every layer | Jev-judged, AST-pre-filtered candidates | 10 |
| S8 | Needless abstraction: single-implementation interfaces, one-call-site wrappers, factories of one | Hybrid: AST finds candidates, Jev confirms | 10 |
| S9 | Doc/code drift and invented APIs: README or comments describing functions or flags that do not exist; imports that do not resolve | Hybrid | 10 |
| S10 | Test theater: tests with no assertions, tests that assert mocks, snapshot-only tests | Hybrid | 5 |

Each signal is normalized 0–1 against human-corpus percentiles per language and size band (p90 = 1.0); score = Σ weight × normalized. Deterministic 55, hybrid 25, LLM-only 20, so it degrades gracefully without Jev (wider interval).

### Agent-written share (reported separately, not part of the score)
- **Evidence floor (deterministic):** % of commits and lines in the last 12 months that carry `Co-authored-by: Claude|Copilot|Cursor|Devin|Codex` (case-insensitive), bot authors, agent branch names, agent PR labels, or agent-generated PR bodies (via GitHub API when authorized).
- **Adoption markers:** `AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.github/copilot-instructions.md`, and `.gitignore` entries for these.
- **Estimate (LLM + style):** Jev labels sampled untraced diffs likely-agent/likely-human/unclear using commit bursts (>500 LOC in <10 min, many files), message style ("feat: Add comprehensive…") and diff style. Output a range, e.g. "≥18% traced, ~30–50% estimated"; never a per-file claim.

### Sampling (target: under 5 minutes on a 500k-LOC repo)
- Deterministic signals run over the whole tree after excluding vendored, generated and lockfile paths (linguist-generated, `.gitattributes`, `node_modules`, `dist`, `*.pb.go`, `__snapshots__`).
- Jev: ~40 files, stratified 50% recent churn (90 days), 25% S1/S4/S5 hotspots, 25% random by LOC; every language >10% of LOC represented. ~300-line chunks, 2 independent passes; disagreement widens the interval.
- Commits: trailer/burst stats over 12 months; Jev reads 30 untraced commits stratified by size.
- Cache by blob SHA; refreshes re-judge only changed files.

### Calibration
1. **Corpus (~300 repos; TS, Python, Go, Rust; three size bands).** Human: repos frozen before 2022-06 (pre-Copilot GA) plus maintainer-confirmed no-agent repos. Agent: [AIDev](https://arxiv.org/pdf/2602.09185) repos with >50% trailer-attributed commits plus Smithers factory output (full provenance). Hybrid: 10–40% traced.
2. **Normalize** each signal against human-set percentiles for each language and size band.
3. **Fit weights** by constrained logistic regression (≥0, sum 100) predicting agent-set membership; hand-review 50 findings per signal and drop signals under 70% precision.
4. **Validate** on held-out repos and newer models; publish AUROC, precision and limitations as reproducible benchmark evidence.
5. **Interval:** bootstrap over sampled files plus Jev disagreement → 80% interval.
6. **Recalibrate quarterly**; model style drifts.

### Presentation
- Show two tiles: **Agent-written share**, e.g. "≥18% traced · ~35% est.", and **Cleanup opportunities: 42 (35–50)**, shown as a bar with its interval rather than a single digit.
- Show the **three largest contributors**. Each is a count plus a file link to the exact lines, for example "23 duplicated blocks → `src/api/handlers.ts:40-88`" or "11 unused exports → `lib/util.ts`". A "Fix with Smithers" button on each launches a cleanup run.
- Under 60% analyzable → "insufficient data", no number.

### Not reading as an insult
- "Slop" is internal only; the owner sees **Cleanup opportunities**.
- Agent-written share reads as a strength, paired with agent-readiness.
- Every finding has a one-click fix; no per-file or per-person authorship claims, no contributor leaderboard; private by default.

## 3. Agent-readiness score (0–100, higher is better)

Modeled on Factory's [Agent Readiness Model](https://docs.factory.ai/web/agent-readiness/overview), which has nine pillars and five levels, where 80% of a level's criteria unlock the next level (deterministic; an open alternative is [kodustech/agent-readiness](https://github.com/kodustech/agent-readiness)). Smithers can do better on one point: it can **run** the checks instead of only detecting config files.

| Pillar | Checks (D = deterministic, R = run, J = Jev) | Weight |
|---|---|---|
| Verify loop | Test command discoverable (D); tests run green in the sandbox (R); wall time under 5 min for a targeted test (R) | 25 |
| CI | CI config exists and gates PRs (D); median CI duration from the last 20 runs via API (D); flake rate (D) | 15 |
| Types and lint | Typed language or strict mode (`strict: true`, mypy/pyright config) (D); linter and formatter configured and passing (R) | 15 |
| Agent instructions | `AGENTS.md`/`CLAUDE.md` present (D); accurate, meaning the commands it names actually run (R); concise and current (J) | 15 |
| Reproducible setup | Lockfile, pinned toolchain (`.tool-versions`, `packageManager`, devcontainer/nix) (D); clean clone builds with one command (R) | 15 |
| Docs and discovery | README with build/test steps (D); architecture docs and module READMEs (J); issue templates and labeled issues (D) | 10 |
| Safety | Secret scanning, branch protection, and no committed secrets (D) | 5 |

Show level 1–5 plus the number and the **three highest-value fixes**, each a "Fix with Smithers" run (e.g. generate `AGENTS.md` from verified commands). Executed checks resist gaming and yield the build/test commands the factory needs anyway.

## 4. Recommendation

Ship in this order:
1. Agent-readiness, since it is deterministic and runnable, with the least risk and the most value.
2. Deterministic cleanup signals S1–S5 with file links.
3. Agent-written share, starting with the evidence floor.
4. The Jev-judged signals, only after the calibration corpus exists.

Do not buy or build a per-file authorship classifier.

## 5. Calibration status (#3150)

Harness landed; the fitted anchors are **not** shipped. `SIGNALS` in `flows/register-repository/cleanup.ts` stays `deterministic-v0` / `hybrid-v0`.

**Method.** `flows/register-repository/calibration/`: `generate.ts` (seeded corpus), `fit.ts` (human p90 per language and size band; logistic regression with weights on the simplex, scaled to the deterministic 55; AUROC; precision at p90), `run.ts` (rewrites `corpus.json` and `fit.json`). Rerun: `node --experimental-strip-types flows/register-repository/calibration/run.ts`. Every third case per stratum and label is held out. Tests: `flows/test/registration-calibration.test.ts` (a rerun matches the artifacts within 1e-3; held-out AUROC at least 0.95; weights non-negative and sum to 55).

**Artifacts.** `corpus.json` (300 synthetic cases: 4 languages x 3 bands x 12 human, 8 agent, 5 hybrid; S1-S5 values), `fit.json` (anchors, weights, AUROC: train 0.992, held-out 0.987, hybrid vs human 0.797).

**Limitations.**
- The corpus is synthetic. Values are drawn from log-normals with assumed per-label multiples of a human baseline; it is not recorded from repositories. Its AUROC shows the harness recovers the generating model, not that S1-S5 separate real agent code from human code. Do not publish it as benchmark evidence.
- S6-S10 are Jev-judged and are not in the corpus.
- No hand review of findings, so the 70% precision cut is unapplied; `precisionAtP90` counts repositories above the pooled p90, not findings.
- Per-stratum human sets are small (8 training cases), so p90 anchors are noisy.

**Remaining for #3150.**
- [ ] Record S1-S5 from about 300 real public repositories (human frozen before 2022-06, AIDev agent, Smithers factory, hybrid) into `corpus.json`, with commit SHAs.
- [ ] Record S6-S10 judgments for them.
- [ ] Hand-review 50 findings per signal; drop signals under 70%.
- [ ] Refit, validate on held-out repositories, publish AUROC and precision with the method.
- [ ] Ship `calibrated-v1` in `SIGNALS`, keeping old labels in the schema union.
