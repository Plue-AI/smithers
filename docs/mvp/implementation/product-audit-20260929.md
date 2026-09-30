# Product audit, 2026-09-29

Product priority: a maintainer receives useful work, trusts the result, and
chooses to delegate again. Revenue optimization follows evidence of that value.
This audit does not establish customer demand, retention, or release readiness.

Inspected Smithers source `f5e23ba446da7cdd3d2ba457f56a22418762f162` and the live
GUI reporting build `f0fcf5198a0d3dfbf071b00537f5c29ae44d542a`. The GUI repair
was then applied to main revision `909d4e3ed4fd216893be03629eb9deacf1f1e6aa`.

## Observed customer paths

| Path | Observed behavior | Product consequence | Owner |
| --- | --- | --- | --- |
| Landing, ordinary click | Opens the signup inline. | Signup works; no authenticated completion was exercised. | [#1881](https://github.com/smithersai/smithers/issues/1881) |
| Landing, new tab or advertised repository URL | The canonical name is missing from the live public catalog; the notice suggests that same missing name. | A prospective user reaches a dead end. | [#2933](https://github.com/smithersai/smithers/issues/2933) |
| Actual public mirror | `smithers-canary/smithers` reads its real homepage and displays four configured apps. | The homepage exists; the canonical URL failure is a catalog/entry mismatch. | [#2933](https://github.com/smithersai/smithers/issues/2933) |
| Signup | Seven optional survey questions precede the ready step. | A useful result before account setup still needs qualification. | [#2167](https://github.com/smithersai/smithers/issues/2167) |
| Natural chat to reviewed pull request | Source has the change request path and local behavior checks. No current authenticated production receipt was obtained. | The complete customer promise is unproven. | [#1723](https://github.com/smithersai/smithers/issues/1723), [#2782](https://github.com/smithersai/smithers/issues/2782) |
| TUI first view | Logo and a general coding prompt; declared repository apps are in the separate `/smithers` panel. | The maintainer has to discover the intended work. | [#2781](https://github.com/smithersai/smithers/issues/2781) |
| TUI declared apps | Four names appear, but execution requires matching locally discovered file flows. The actual homepage names have no such match in the observed project. | Selecting a promised responsibility produces no run. | [#2125](https://github.com/smithersai/smithers/issues/2125) |
| TUI local coding | A real terminal test edits a file, executes its check, and retains completion. Its model is an offline replay. | Local execution works; this proves neither live model quality nor Cloud completion. | [#2785](https://github.com/smithersai/smithers/issues/2785) |
| Terminal distribution | Three sampled compiled TUI package names return npm 404; the guide currently asks users to build from source. | Installation is too much work for an ordinary first trial. | [#2483](https://github.com/smithersai/smithers/issues/2483), [#2845](https://github.com/smithersai/smithers/issues/2845) |

## Immediate repair

[#2933](https://github.com/smithersai/smithers/issues/2933) changes the landing
href and quickstart to `/?tutorial`, matching the existing global signup. Asset
loading retains its own prerendered shell document. Missing-repository links
come from the current validated public catalog, with request ownership preserved.
No arbitrary mirror is made a global source alias.

Local source and browser checks on the candidate reported:

- App and site typechecks pass. The site build passes.
- Repository admission and suggestion tests: 43 pass.
- Built-site contract tests: 21 pass.
- Browser cases: 7 app cases and 9 built-site cases pass, including actual new-tab
  signup navigation, held/failed catalog reads, reload, stale results, and the
  existing authenticated write boundary.
- Documentation checks: 273 pages, zero violations; the generated text check
  passes.

On the newer main revision, app and site typechecks and the site build also
pass. Repository admission plus authentication-chat tests pass (68 cases),
site contract plus documentation-text tests pass (38 cases), and all nine
built-site browser cases pass. Six app browser cases passed initially. The
seventh case's stale failure-copy assertion was updated and its focused rerun
passes: infrastructure failure, Retry, collapsed Details, typed cause, failed
toast, four homepage apps, and editable Chat remain covered. Related copy
reconciliation: [#2879](https://github.com/smithersai/smithers/issues/2879).
The same-origin asset checks introduced on main remain in place.

These are local results. The issue stays open until the change is delivered
through the existing release path and the deployed first-use receipt is retained.

## Next product evidence

Two live usefulness probes sharpen the next work. Anonymous GUI chat submitted
one repository question and received HTTP 401 in 289 ms, asking for GitHub
sign-in; no provider execution or answer was observed. Later fresh public
mirror visits also encountered a hanging homepage read, despite its earlier
successful response. This is evidence of a failed visit, not proof that every
public homepage is unavailable.

The TUI received the same bounded factual request on an isolated copy of the
real factory file: name its four home apps and their flow IDs. It returned no
answer with either our 10,000-token ceiling (6,984 tokens reported, 8.686 seconds)
or our 20,000-token ceiling (15,441 reported, 11.398 seconds). Files remained
unchanged. The TUI's default budget is unbounded; these probes establish failure
under the stated constraints, not a budget calculation bug or failure of the
unbounded default. A bounded event trace then established the cause: the model
read the file and supplied the correct answer, but the unchanged-workspace guard
discarded that completion before its completion claim judge ran. The next model
call was refused by budget admission. Repair:
[#2937](https://github.com/smithersai/smithers/issues/2937). Broader usefulness
investigation: [#2176](https://github.com/smithersai/smithers/issues/2176).

Use the existing Cloud factory to carry one approved issue through checks,
review, owner merge, wiki refresh, and its completion receipt. Drive it through
the GUI and TUI, including one interruption and recovery. [#1780](https://github.com/smithersai/smithers/issues/1780)
owns the loop; [#2781](https://github.com/smithersai/smithers/issues/2781),
[#2782](https://github.com/smithersai/smithers/issues/2782),
[#2783](https://github.com/smithersai/smithers/issues/2783), and
[#2785](https://github.com/smithersai/smithers/issues/2785) own the interface and
recovery receipts. Reuse those issues rather than adding a second parity program.

Then observe real maintainers completing the same job and requesting another.
Capture the useful result, acceptance, elapsed time, and interventions. A request
accepted by the launcher does not count as a completed job; a passing local
test does not count as a customer returning.

## Evidence limits

No sanctioned authenticated production browser profile or saved Smithers CLI
login was available. No signed-in coding run, main landing, wiki publication,
installer publication, or customer retention is claimed. Supported Node 26.5.0
is installed locally; failures under the shell's Node 24.4.1 and forced Bun CLI
execution are outside the CLI's documented runtime contract.

Sanitized captures, commands, and review receipts were retained locally during
this audit. Public testing campaign:
[#2290](https://github.com/smithersai/smithers/issues/2290).
