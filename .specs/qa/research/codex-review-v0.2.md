Read-only adversarial review of validation-plan.md v0.2.

I read the plan, all four research inputs, the supplied product and engineering contracts, the checks index and all 112 C-* files, the tickets index, and AGENTS.md. I did not run tests or change source. This review distinguishes a requirement mentioned in prose from a gate that can reject a build. Findings 16–25 are the ten additional risk scenarios: existing broad hooks are acknowledged rather than misrepresented as absent.

References beginning with validation-plan.md, gap-analysis.md, test-infra.md, eng-progress.md or findings/LOG.md are relative to the supplied scratchpad/qa directory. References beginning with .specs/ or AGENTS.md are relative to ~/smithers-qa. Line numbers refer to the files as read. The supplied tree has no Git metadata, so I cannot independently certify its main SHA. Content SHA-256: plan c456f595835ac65e934e49eec09c647af2ae93382788ad430bb993000ed153bb; mvp.md 64ab833aaf06e864cc8df6a5624b83ed02b7cab63c2d49d4e84e642e5bf7d851; spec.md 06b2c4fde9c8675cb510cc0c2d8146804a7d4ec52d653107bcbd179533bd7942.

1. **blocker — “Gate” currently includes triage, proposals and a severity filter; these do not establish readiness.**

   **Plan section:** §2 G-MAIN, stage gates and G-REL; §6.

   **Evidence:** validation-plan.md:7, :49–59, :82, :182; .specs/product/mvp.md:55, :57, :534–535, :588–599.

   **Finding:** “completed CI run triaged” can succeed with every job red. “Target state” green “at least once a day” does not reject an intervening broken commit. Required PR checks remain a “Proposal” until three green days. “S2 is a broken journey step with a workaround,” while the global defect blocker is only S1. Existing ticket checks do have an explicit pass requirement; the missing rule is that every required journey/quality criterion, including the additions, blocks its stage regardless of defect severity. A missing Source/Run check plus a workaround can leave zero S1 defects while J11 is broken.

   **Concrete fix text:** “G-MAIN-TRIAGE is an operational status, never a qualification receipt. A stage or release qualifies only when every mandatory criterion has PASS evidence for the candidate and required environment; FAIL, BLOCKED, SKIPPED, NOT IMPLEMENTED and missing evidence reject qualification. Severity routes repairs and cannot waive a required criterion. Enable the agreed required PR checks before the factory starts landing work; a green run on an older commit does not qualify a newer candidate.”

2. **blocker — The requirement-to-gate mapping is incomplete, and ‘low risk’ is incorrectly used to discard P0 and quality-bar requirements.**

   **Plan section:** §2 stage gates; §§3.1–3.3; §5.3.

   **Evidence:** validation-plan.md:14, :82, :97–123, :127, :174–178; gap-analysis.md:435–477, :498, :504, :516; .specs/product/mvp.md:151, :159, :168–171, :195, :213–215, :221, :255–257, :488–490, :529–537.

   **Finding:** §3.2 claims to carry “each with layer and pass condition,” but supplies no stage tags for G04–G07, G12, G22 or G24–G51. The referenced gap table also has no stage column. Therefore §2's requirement for “QA additions tagged for that stage” has no usable denominator. Weak-check repairs are merely “one batch.” G52–G77 disappear altogether, although that group includes:

   | Contract obligation | Actual hole in the proposed gate |
   | --- | --- |
   | §9 Branch wake, mvp.md:530 | G76, cold wake after a recipe change, is excluded; C-J1-02 covers initial setup, not this wake. |
   | §9 Live updates, mvp.md:531 | G77, agent write-tool latency, is excluded; C-PERF-04 measures SSH writes. |
   | §9 Keyboard, mvp.md:535 | G43 is proposed without an assigned stage; C-UI-01:13 omits J6–J8 and J11. |
   | §9 Honesty and §2 rule 5, mvp.md:57, :534 | The all-card extension is a sentence, without a state/scenario inventory or completion receipt. |
   | J1, mvp.md:168–171 | G44 full supported toolchains and G46 ChatGPT access have no stage. Preserve the existing C-J1-03 source-before-image proof as well. |
   | J3.6, mvp.md:195 | G62's Answer/Steer surface is discarded as cosmetic, even though it is the prescribed question interaction. |
   | J6, mvp.md:213–215 | G45 is unassigned; the real agent edit path is not established by CLI/catalog checks. G59 is discarded. The product permits Claude OR Codex, so do not manufacture a requirement to prove both subscriptions; do prove the selected real path and honest supported attribution. |
   | J7.1 and §4.2, mvp.md:151, :221 | G71 acceptance-criteria amendment is discarded; existing prompt amendment alone is insufficient. |
   | J11, mvp.md:255–257 | G40 has no gate attachment; G64 preview/authoring is discarded. |
   | M-34/M-35/M-36, mvp.md:488–490 | Agent participation, in-app docs and the API playground are absent from the research decision matrix, which stops at M-33. |

   App-agent latency, ordinary GitHub freshness, copy and the principal durability/isolation paths already have named C-* paths. They need execution, not claims that they are entirely untested. The missing cases above are additional obligations.

   **Concrete fix text:** “Publish a closed manifest containing every §2 rule, §9 row, P0 journey step and §12 item. Each row names the normative line, stage, check or subcase, implementation owner, runner, binary/numeric oracle and artifact. Include every G/W item until product explicitly removes its requirement. Risk changes execution order, never required scope. A row without these fields is BLOCKED and prevents its stage exit.”

3. **blocker — Component checks are being substituted for the specific release recording, and the actual maintainer-release upgrade receipt has no honest calendar.**

   **Plan section:** §2 G-REL items 1 and 6; §5.3 Upgrade.

   **Evidence:** validation-plan.md:88, :93, :123, :178; .specs/product/mvp.md:588–594, :599, :611; .specs/engineering/checks/C-J3-04.md:18; .specs/engineering/checks/C-J8-04.md:18–23; .specs/engineering/checks/C-REL-03.md:7–8; gap-analysis.md:435–438, :498, :504.

   **Finding:** All six §12 items appear in the release table, but item 1 lacks an executable recording manifest. The external-save test still has one typist; citing C-J3-04 does not meet the two-active-typists requirement. Citation of wiki revision 4 does not prove the next plan follows its rule. G40 is discussed in §3.2 but absent from the release evidence cell, despite the missing C-J11-02. Separate crash-test logs do not establish the required recovery receipts in the recorded product journey. Finally, “next build” is not necessarily the maintainer release. The contract requires an actual launch-day-install → maintainer-release upgrade, but that release ships a week later and must not be built early.

   **Concrete fix text:** “G-REL-1 requires a timestamped recording index for J1–J8/J10/J11, both themes, fresh Mac mini, second laptop and real GitHub. Index all six inclusions at mvp.md:589–594, including an external save while BOTH people actively type, recoverable stale bytes, and a discriminating wiki rule that the next plan actually applies. Attach G40, W14, W20 and G33 as mandatory subcases. G-REL-6 distinguishes a prelaunch upgrade rehearsal from the actual N→maintainer-release receipt. Product must resolve the future-receipt/launch-approval timing explicitly; QA keeps the actual receipt pending and never calls a synthetic later build the maintainer release.”

4. **major — Catalog parity is not execution parity across the product's doors.**

   **Plan section:** §2 always-on checks; §§3 and 5 campaign.

   **Evidence:** validation-plan.md:58, :157, :175, :177; .specs/product/mvp.md:53, :56; .specs/engineering/checks/C-CAT-01.md:4, C-CAT-02.md:4, C-CAT-03.md:4; AGENTS.md:176–178, :194–198.

   **Finding:** The checks strongly cover schemas/catalog membership, but the plan supplies no runtime conformance gate proving that browser action, slash command, app-agent tool, installed CLI and HTTP API dispatch the same typed flow with the same authorization and durable result. Nor does it assign public Flow.make authoring-boundary validation or a complete real-card maximize/action inventory. A duplicated handler can preserve every catalog schema and still bypass runtime authorization or projection persistence.

   **Concrete fix text:** “For the stage-1 mutation and refusal matrix, invoke the shipped browser/CLI/API/tool boundaries and compare flow tag, decoded payload, principal, run/attempt identity and persisted outcome. Exercise malformed input, duplicate request, cancellation and permission refusal. Add one repository-authored Flow.make flow through load, typed form, invocation and Inspect. Enumerate every required card and verify inline/maximized actions in the real app. Keep schema parity tests as independent unit evidence.”

5. **blocker — The plan adopts a trust check that explicitly authorizes a launch-forbidden action.**

   **Plan section:** §§2–3 acceptance-check adoption; §5.3 Security.

   **Evidence:** .specs/engineering/checks/C-SEC-03.md:7–8, :17, :24; .specs/product/mvp.md:501, :616–618; validation-plan.md:11, :63, :131, :177.

   **Finding:** C-SEC-03 makes Ben a Member, then passes when Ben labels outsider Dana's issue and creates credentialed TODO work. The product says an outsider issue becomes a TODO only through a Maintainer's action, enforced from launch. None of G08–G14 fixes this distinction. A “table transcribed from spec” can institutionalize this permission breach because the engineering mapping is broader than the product rule.

   **Concrete fix text:** “Amend the admission oracle before implementation approval: Member→team-authored issue is permitted; Member→outsider issue is refused with zero TODOs, runs, credentials and machine requests; Maintainer-session→outsider issue is the permitted approval door. Exercise both Make TODO and label admission, webhook/poll races, delegation and replay. Route the spec/check conflict to product and engineering; the product trust rule controls until reconciled.”

6. **major — Several normative conflicts must be resolved before the proposed test oracles can be trusted.**

   **Plan section:** §3.4; G-REL docs/cuts.

   **Evidence:** validation-plan.md:91, :129–131; gap-analysis.md:532–545; .specs/product/mvp.md:488–490, :494, :520; .specs/engineering/checks/C-REL-01.md:15–17, :23; C-J6-01.md:26; C-CUT-01.md:20–25, :32; AGENTS.md:39–45, :69–70.

   **Finding:** “The four that change code” is unjustified: X15's overridable merge steps and X11's draft fallback also affect code and safety. New M-34 replaces the old “Ben via Smithers” rendering, but the plan still relies on old attribution oracles. M-35 removes the standalone docs site, while C-REL-01 passes a site /docs sidebar. M-36's advanced /debug-api flow is missing. C-CUT-01 can demand removal of retained non-MVP CLI paths and fail merely because an old persisted card remains readable; AGENTS explicitly preserves published libraries/CLI capabilities and decoding existing history. These are contradictory acceptance targets, not harmless documentation drift.

   **Concrete fix text:** “Before accepting a lane oracle, reconcile every behavior-affecting contradiction against the current product contract, including M-34–M-36 and X11/X15. Change C-REL-01 to validate the in-app /docs flow and shared Markdown, plus preinstall README/install content. Cuts remove new product entry points while retaining supported libraries/CLI groups and historical read-only decoding. Record one normative decision and update spec, checks and dependent lane tables together.”

7. **major — The harness and gap build order does not produce the stage-1 walking skeleton first.**

   **Plan section:** §§3.1–3.2; §4.

   **Evidence:** validation-plan.md:99–123, :137–147, :164; .specs/product/mvp.md:560–572, :373; .specs/engineering/overview.md:91–110; .specs/engineering/tickets/README.md:22–25; .specs/engineering/spec.md:468.

   **Finding:** Serially fixing all 14 package targets, faults and script gates before building the minimal self-host driver is an unbounded first step. The existing PostgreSQL fixture is third, evidence infrastructure is last, hardware/account provisioning is sixth/seventh, and coverage is tenth. Meanwhile ordinary stage-1 functionality is buried in “S2 gaps”: Retry-current-flow, queued/paused steering, start failure, normal draft promotion, concurrent order updates and atomic file writes. P9 is explicitly tagged S2 even though stage 1 fixes the write contract. Security flags needed to execute real isolation tests must not wait for the whole stage-2 Linux program.

   **Concrete fix text:** “Start with (a) stage/check manifest and minimal result writer, (b) existing real PostgreSQL fixture plus fast unit/coverage checks, (c) minimum GitHub fake endpoints needed by access/create/propose/merge, and (d) one real microVM/browser J1→J2 driver. Provision reference hardware and verified GitHub access immediately in parallel. Attach G22/G25/G28/G31/G35/G36 and the relevant G27 subcases to S1; split G26 by the stage where release/admission exists. Put P9's stage-1 write API/tool proof in S1. Expand daemon bursts, multi-user homes and Yjs at S2/S3. Full-CI repair runs alongside this path with a separate owner; HTML presentation waits.”

8. **major — The five-minute priority loop will starve the harnesses and cannot perform its promised work.**

   **Plan section:** §1; §7; §9.

   **Evidence:** validation-plan.md:25, :37–40, :68, :187–193, :205–207; eng-progress.md:139, :146–147; .specs/engineering/tickets/README.md:25.

   **Finding:** One QA agent owns CI repair, every check rerun, every recording, every hand-written oracle review, harness construction and campaigns. With 13 lanes, the first three queue classes can remain permanently nonempty; harnesses are priority 5 although priorities 1–2 depend on them. A 20–60-minute suite or a 40-minute timeout cannot be reproduced, fixed and regression-tested within a five-minute round. “One per journey per stage” is 16.5 hours of exploratory time alone if applied to all 11 journeys. Throttling fix agents to two does not bound the other lanes' VM/build load.

   **Concrete fix text:** “The five-minute loop only ingests results, assigns issues and polls durable background jobs. Maintain a persisted queue with dependency-aware states and one active heavy qualification job per test host initially. Reserve an uninterrupted harness slot and a separate CI-repair owner; delegate bounded test/fix tasks to the required Sol workers. Prioritize the thin S1 path and run exploratory charters only for capabilities available in that stage. Set limits on all build/VM workers, not just repair workers, and report queue age plus blocked reasons.”

9. **major — ‘Nightly pinned run’ and reference-host qualification remain wishes, with no runnable scheduling mechanism.**

   **Plan section:** §2 stage blockers; §4 H6–H8; §9.

   **Evidence:** validation-plan.md:21, :30, :75, :142–144, :204–206; test-infra.md:119–121, :136–139; .specs/product/mvp.md:525; .specs/engineering/checks/README.md:14; .specs/engineering/checks/C-J1-06.md:4.

   **Finding:** With frequent pushes, a completed “latest main” full run may never exist. A pinned nightly run is merely proposed and can itself be canceled by concurrency grouping. H7 is absent from G-S1 blockers even though many S1 e2e checks already require the reference host. “SMITHERS_REQUIRE_MICROVM_TESTS set somewhere” has no executor. Product specifies a 32 GB reference Mac mini; engineering says the team mini “whatever its size.” The plan never resolves that conflict. A Linux lane can exercise inotify/cgroups but cannot certify Apple Hypervisor, signing, launchd or the Mac install.

   **Concrete fix text:** “Commit to one completed qualification run per nominated SHA: start an existing/manual runner with cancel-on-new-push disabled, cap its heavy concurrency, archive its result and process the next candidate afterward. Ordinary fast PR checks remain separate. Assign a date and owner for the Mac mini, second laptop and GitHub verification; if unavailable, keep the affected gates BLOCKED. Record the agreed reference profile and reconcile mvp.md:525 before accepting perf. Name the actual Linux/VM runner, required environment flags and skip-to-failure behavior. On the reference host, exclude unrelated heavy jobs during perf and retain load/pressure/network samples.”

10. **major — The campaign contains slogans rather than falsifiable suite definitions.**

   **Plan section:** §§3.2–3.3, 4 H9, 5 and 8.

   **Evidence:** validation-plan.md:123, :127, :145, :151–177, :197; .specs/engineering/checks/README.md:3.

   **Finding:** “nightly time budget” gives no duration; P14–P17 have no individual stage; “every visible state,” “axe on every card,” and “secrets scan of machine files, logs and captures” have no enumerated population or completion oracle. The 30-minute exploratory charter bounds time, not required cases or pass/fail. “Pictures, not lists” cannot substitute for blocked/skipped counts. QA is an overall owner, but there are no individual implementation assignments or deadlines for the promised suites and repairs.

   **Concrete fix text:** “For each P suite, fix its independent reference model, stage, worker and runner; run 1,000 generated sequences from recorded seeds in PR qualification and a 15-minute campaign per suite in the nightly schedule, initially prioritizing S1. Specify bounded sequence lengths and boundary generators. Persist seeds, counts, failures and shrunk counterexamples. For card/security sweeps, generate an expected inventory and fail on any omitted element or forbidden observation; for axe, publish the exact rule set and permitted reviewed exceptions. Exploratory charters record cases attempted and findings; they never supply a missing deterministic gate. Report PASS/FAIL/BLOCKED/SKIPPED/NOT IMPLEMENTED and expected denominators.”

11. **major — Some proposed properties are wrong, impossible over their generators, or too vague to identify a real durability failure.**

   **Plan section:** §3.1 G17; §5.1 P2, P4 and P7.

   **Evidence:** validation-plan.md:114–115, :156, :162, :165; gap-analysis.md:556, :558, :561; .specs/engineering/checks/C-STK-04.md:11–25; .specs/engineering/spec.md:495, :659, :934.

   **Finding:** P2 says “only the first unmerged item merges” while generating out-of-order GitHub merges, which the product expressly handles. G17's global “at most one … non-draft” conflicts with G18's draft-unsupported fallback. P4's capacity≥1 plus “never above any term” cannot both hold when the free-disk term is zero/negative. P7's “acknowledged keystroke” does not identify which acknowledgement is durable; the spec guarantees acknowledged “Saved to the machine,” not merely transmission of a character. These tests can reject correct behavior or avoid the bad boundary by weakening their generators.

   **Concrete fix text:** “P2 constrains Smithers-issued merges to the first item; external out-of-order merges must fold included items and open order attention. G17 applies only when drafts are supported; the fallback has its own weaker, explicit invariant. Resolve low-resource admission separately from the positive-capacity formula, including below-minimum hosts/disks. Define the durable acknowledgement for P7 and assert all writes acknowledged Saved survive kill/recovery. Sample the operation log/linearization points, not only periodic state snapshots.”

12. **major — The flake rule can conceal race bugs and remove required evidence.**

   **Plan section:** §6.

   **Evidence:** validation-plan.md:184; AGENTS.md:190–193, :199–201; .specs/product/mvp.md:533.

   **Finding:** “a red that passes on rerun at the same SHA” classifies genuine races and intermittent data loss as flakes. An issue, owner and seven-day expiry do not justify quarantining a mandatory criterion. “Check evidence never uses retries” is good, but it conflicts with any release claim based on a green suite after the failing mandatory test has been removed.

   **Concrete fix text:** “A pass after a failure is a reproducibility observation, not a flake diagnosis. Retain the original seed, timing, operation log and first-run result. Quarantining a mandatory check leaves its stage BLOCKED until the defect is fixed or independent equivalent evidence is approved against the same criterion. Expose quarantines and skipped counts in the manifest; never delete the failure from qualification history.”

13. **major — Ticket closure omits two engineering requirements and does not explicitly forbid product code in Plue.**

   **Plan section:** §1 ownership; §2 G-TKT.

   **Evidence:** validation-plan.md:39–40, :62–66; .specs/engineering/tickets/README.md:3–9; AGENTS.md:134–137; eng-progress.md:132–133; findings/LOG.md:13–14.

   **Finding:** G-TKT's “all four” conditions omit “nothing in delta.md … remains” and “every old path … deleted in the same change.” A lane can meet the proposed QA rule while leaving a second backend or old migration behavior. The ownership row groups backend, Plue and deploys without clarifying that Plue is a private composition and must not acquire product implementation. The research already found multiple install_settings and sign-in implementations, so this is an observed integration hazard.

   **Concrete fix text:** “G-TKT additionally requires zero remaining ticket delta, updated affected docs, deletion of the replaced implementation in the same change, and product implementation only in packages/backend. A passing subset is PARTIAL evidence and cannot close a ticket whose named check depends on later code. Add post-landing schema/router/runtime-composition receipts for the migration and auth collisions recorded in Q-010/Q-011.”

14. **major — The plan does not implement the testing workforce rule or establish the required coverage gate.**

   **Plan section:** §1 QA repair ownership; §4 H10; §§5 and 7.

   **Evidence:** validation-plan.md:37–40, :146, :151, :189–193; AGENTS.md:190–207; .specs/engineering/spec.md:1228–1235; test-infra.md:131, :136–139; eng-progress.md:139–141.

   **Finding:** “QA … claim, fix, regression test” and “QA-owned tests” never bind test work and discovered product fixes to GPT-6.1 Sol as AGENTS requires. H10 measures only Go backend coverage, comes tenth and has no 100% pass oracle; app/TS/Rust production changes are outside it. Selected-test coverage below an existing threshold, skipped real VM suites and synthetic helpers cannot become qualification by relabeling them. The campaign also omits #2290 tracking. Fake GitHub is an explicitly permitted engineering integration exception; do not demand live GitHub for every unit/integration case, but do retain real dependency and live e2e evidence.

   **Concrete fix text:** “QA orchestrates and reviews; assigned GPT-6.1 Sol agents implement tests and fix every discovered product bug, preserving regression receipts. Use a bounded worker count matching host capacity. Measure executed coverage for the full production scope of each touched package in every language and enforce the repository's 100% requirement without exclusions, lowered thresholds or hidden production paths. Report full configured versus executed scope, skipped cases and platform evidence separately; require meaningful unit and integration confidence independently. Track this campaign and outstanding evidence in #2290.”

15. **major — Local, gitignored evidence links are not durable or independently reviewable.**

   **Plan section:** §2 G-TKT; §4 H11; §8.

   **Evidence:** validation-plan.md:65–66, :78, :147, :197–198; .specs/engineering/checks/README.md:16; .specs/engineering/tickets/README.md:5; eng-progress.md:120, :142; .specs/engineering/checks/C-UI-08.md:19–20.

   **Finding:** An issue linking an author's .artifacts directory does not attach evidence for another machine, a removed temporary checkout or a future reviewer. The one closed ticket already lacks the expected artifact. A late HTML page cannot repair missing raw receipts. “Every earlier check re-run on the reference host” also cannot replace named Linux/24-GB/second-device environments. The research calls C-UI-08 vacuous before Views exist; its current oracle requires every specified card to have View/Container/schema, so an empty scan must actually fail that oracle.

   **Concrete fix text:** “Create the minimal evidence writer first. Each immutable result records check/subcase, candidate SHA, spec/check content identity, install version, exact command, executor/platform/host profile, expected and executed cases, first result and artifact hashes. Upload redacted artifacts to a durable authorized store or attach them to the issue; retain an independently usable location. Local paths may be working copies. Preserve original required environments in the release rerun matrix. Fail empty expected populations; architecture/import scans alone cannot pass C-UI-08.”

16. **blocker — Additional risk 1/10: real pre-MVP data and PostgreSQL distribution upgrades can be silently damaged.**

   **Plan section:** §2 G-REL-6; §3.2 G07; §5.3 Upgrade.

   **Evidence:** validation-plan.md:93, :123, :178; gap-analysis.md:377; .specs/engineering/checks/C-REL-03.md:7–12, :21; .specs/engineering/spec.md:103, :1138–1140; AGENTS.md:39–45, :69–70; eng-progress.md:132.

   **Finding:** G07 covers legacy conversations, and C-REL-03 covers data created on the launch candidate. Neither exercises an actual existing install's old journals/card kinds, issue-to-TODO state, roles, sealed credentials, migration ledger and pending external actions together. Worse, C-REL-03 deliberately excludes rewritten columns from its digest: the very data being migrated can be erased while the check passes. No case establishes what happens when Homebrew changes the PostgreSQL executable/cluster compatibility, or two services attempt migrations after the recorded 0104 collisions.

   **Concrete fix text:** “Backend/install owners add a sanitized real pre-MVP install fixture, plus N→N+1 fixtures with pending work. Compare rewritten data to explicit expected transformations rather than excluding it; assert zero unexplained row loss/orphans, readable legacy journals/cards and unchanged sealed-value decryptability and Git refs. Kill/restart at each migration boundary and race two migration starters. Record the supported PostgreSQL binary/cluster transition; test a supported package upgrade and an unsupported older-major cluster. Unsupported input must refuse before mutation and remain runnable/restorable with the previous bundle, rather than silently initializing a new cluster.”

17. **blocker — Additional risk 2/10: backup/restore can pass on mutually inconsistent data or be unusable after losing the original install.**

   **Plan section:** G-REL-6; §3.2 G06; §5.3 Upgrade.

   **Evidence:** gap-analysis.md:376; validation-plan.md:93, :178; .specs/engineering/spec.md:1136–1148, :1164; .specs/engineering/checks/C-REL-03.md:12–16, :20–22.

   **Finding:** Backup is not absent: G06 exists and failure restore exists in C-REL-03. The uncovered risk is coherence and independence. Refusing only an open burst/merge does not prove a DB dump, wiki/blob revision, run journal, Git head and VM disk represent one recoverable boundary. APFS clones under the same $STATE do not demonstrate recovery without the live install, install key or original Cellar. No corrupt/truncated-backup or wrong-key negative restore protects the destination.

   **Concrete fix text:** “Install/backend owners add a backup qualification with concurrent acknowledged wiki, run and branch mutations. Require a documented quiescence fence and capture all Saved data before the backup manifest commits. Copy that completed backup to a separate volume, remove access to the live root and original Cellar, and restore into a clean stopped data directory with network disabled. Verify members, key/decryption, wiki revisions/blobs, journals/flow closures, Git refs and per-VM homes and uncommitted bytes. Test missing chunk, corrupt manifest and wrong key: restoration refuses before replacing the destination. A partial backup never gets a completed manifest. This is recovery testing, not a new hosted-backup feature.”

18. **major — Additional risk 3/10: persisted logs and QA artifacts can leak host credentials on error paths.**

   **Plan section:** §5.3 Security; evidence handling.

   **Evidence:** validation-plan.md:177; .specs/engineering/checks/C-SEC-01.md:8–12; C-MCH-07.md:19, :28; C-GH-01.md:18, :31; .specs/engineering/spec.md:1164, :1203.

   **Finding:** The plan does mention logs, and C-MCH-07 scans projected logs. The missing scenario is leakage from host/provider/OAuth/relay failures into structured logs, raw journals, HTTP headers/URLs, browser HAR/console, crash diagnostics and uploaded receipts. Guest absence and no plaintext pg_dump do not prove redaction across those surfaces. An all-branches secret printed in its owner's terminal is explicitly permitted, so a blanket “zero secret anywhere” oracle would itself be wrong.

   **Concrete fix text:** “Security/backend owner runs distinct sentinel values through model access, App PEM/client secret, OAuth exchange, delegated bearer and bound-secret relay success AND failures/retries. Scan each enumerated persisted/shared/diagnostic/artifact surface for raw values and specified common encodings, with positive scan controls and an explicit allowed-terminal boundary. Pass requires zero forbidden matches and no new broad credentials in evidence. Produce redacted receipts before durable upload; retain access permissions and artifact hashes.”

19. **blocker — Additional risk 4/10: approved issue text can inject instructions into a credentialed coding agent.**

   **Plan section:** §3.1 security additions; §5.3 Security.

   **Evidence:** .specs/engineering/checks/C-SEC-03.md:8, :17, :24; validation-plan.md:106–112, :157, :177; .specs/product/mvp.md:483–484, :501, :616; .specs/engineering/spec.md:1154–1166.

   **Finding:** C-SEC-03 checks admission before a member acts. It does not test the malicious text after a legitimate Maintainer admits it, or injection via discussion/review/wiki context. G08's restricted app-agent tool list and P3 authorization tables do not exercise the actual coding-host credential wiring. A prompt that asks to read teammate tokens, exfiltrate host keys, run root lifecycle code, disable checks, override merge or manufacture a person's approval needs observable containment, not the assertion that a model will ignore it.

   **Concrete fix text:** “Security/flow owners add an admitted hostile issue/discussion corpus executed through the real coding-host tool boundary. Use a scripted adversarial model to deterministically attempt every forbidden operation, plus a recorded live-agent canary. Require zero host-code executions, privileged lifecycle executions, teammate credential reads, provider/App-key exposure, unauthorized outbound GitHub effects or approvals; main stays unchanged until a real reviewed-revision approval. Persist attempted calls and refusal receipts. Include source changed after approval and forged identity/tool-result instructions. Containment is enforced by runtime permissions and secret isolation, not a prompt-following success rate.”

20. **major — Additional risk 5/10: correct manifest permissions do not prove narrow effective GitHub credentials.**

   **Plan section:** §4 H2/H6; §5.3 Security.

   **Evidence:** .specs/engineering/checks/C-GH-01.md:28, :38; .specs/engineering/spec.md:869–882; validation-plan.md:138, :142, :177.

   **Finding:** C-GH-01 already checks exact requested scopes. The missing risk is the installation/token actually selected at runtime: a broad installation, wrong installation id, another repository, increased permissions, cached token after suspension/removal, or lost administration/checks access. A manifest equality assertion and fake route permission sweep cannot prove effective GitHub authority. Removing workflows:write would contradict this contract; narrowing repository/token reach and verifying refusal are the appropriate tests.

   **Concrete fix text:** “GitHub/security owners qualify the real App on an organization and a personal-repository setup. Verify the configured single repository and effective token repository/permission set; reject a setup/runtime selection that broadens it silently. Attempt an API/git operation against another repository and forbidden organization/admin mutations: require refusal and zero effect. Remove/reduce installation permissions or suspend the App while a token is cached; calls fail honestly, Merge holds, and no PAT/env fallback occurs. Never publish token bytes in the scope receipt.”

21. **major — Additional risk 6/10: shared rate pressure and paginated changes can lose events or create retry storms.**

   **Plan section:** §4 H2; §5.1 P10/P11; §5.2.

   **Evidence:** .specs/engineering/checks/C-GH-08.md:7–8, :18, :22–28; .specs/engineering/spec.md:889–904; validation-plan.md:158–159, :171.

   **Finding:** Rate limits are already covered in the ordinary three-hour fake test and an exploratory charter. Neither specifies secondary-limit 403 behavior without the modeled header, coordinated pressure from pollers/permission checks/writes, restart during Retry-After, or more than one page of changes sharing an updated timestamp. A perfectly idempotent stream can still omit page-two issues/reviews or repeatedly hammer a blocked installation.

   **Concrete fix text:** “GitHub owner adds a deterministic fake scenario with 150 changed objects across three pages, equal timestamp boundaries, duplicate/reordered deliveries and restart between pages. Assert every relevant event is applied once and the watermark never skips an unapplied page. Exercise 403/429, documented Retry-After forms, reset boundaries, low budget, expired token and concurrent scheduler workers. Retain request timestamps; no request violates the chosen backoff deadline, at most one scheduler request is in flight per installation/stream and token refresh has one owner, unaffected authorized streams continue, and limited/stale health cannot report fresh.”

22. **major — Additional risk 7/10: clock jumps and timezone boundaries can extend authorization or poison credential convergence.**

   **Plan section:** §3.1 G14; §5.1 P14/P17; §5.2.

   **Evidence:** validation-plan.md:111, :166, :171; gap-analysis.md:568, :571; .specs/engineering/checks/C-REL-04.md:22, :28; .specs/engineering/spec.md:319, :333, :573.

   **Finding:** G14 covers 24 h + 1 s; P14 covers scorecard window shifts; P17 covers credential timestamp ties. None covers wall time moving backward/forward while confirmation/token/sleep deadlines are active, a guest submitting a far-future credential timestamp, host/guest drift across sleep, or restart spanning DST. “Clock skew” in a charter has no security oracle. A future written_at can win forever, and a backward jump can resurrect an expired approval if elapsed time and wall time are conflated.

   **Concrete fix text:** “Auth/credential owners specify monotonic in-process durations and persisted UTC deadlines, including conservative security behavior on restart/clock discontinuity. Test ±1 h jumps, suspend/resume, ±24 h host/guest skew, exact expiry edges and a far-future guest timestamp. Revoked tokens never revive; expired confirmations never extend; credential convergence cannot be permanently pinned by an untrusted clock. Scorecard owner tests both DST transitions and UTC window boundaries with the same event set and explicit half-open intervals; counts and duplicate prevention remain exact.”

23. **blocker — Additional risk 8/10: disk-full can acknowledge writes it cannot persist, or destroy the only usable backup.**

   **Plan section:** §4 harnesses; §5 fault campaign; §9 load risks.

   **Evidence:** eng-progress.md:146; validation-plan.md:140, :162, :206; .specs/engineering/spec.md:489–495, :653–659, :1138; .specs/product/mvp.md:533–534.

   **Finding:** The research already reports 9–30 GiB free and an 8-GiB build stop. Yet no C-*, G or P case injects ENOSPC into PostgreSQL, the VM disk, document temp-write/fsync/rename, snapshot/ref update, logs or backup creation. P4 checks the capacity formula, not failure while an admitted machine is writing. Kill/restart tests do not reproduce partial writes caused by exhausted storage.

   **Concrete fix text:** “Install/durability owners add bounded-volume or fault-hook cases at DB commit/WAL, VM document save, capture/ref update and backup publication. At each point exhaust the relevant volume and restart. Pass requires no Saved/completed acknowledgement for unpersisted data, preservation of every previously durable acknowledged byte, typed visible failure, no partial candidate merged and no completed-backup manifest for incomplete bytes. Free space and retry: recovery works without duplicate external effects. Test low-disk admission refusal independently of the minimum-capacity formula; retain the last known usable backup.”

24. **major — Additional risk 9/10: concurrent installers/starters on one Mac can share state or perform initialization twice.**

   **Plan section:** §4 H5; install gates.

   **Evidence:** .specs/product/mvp.md:54, :65; .specs/engineering/spec.md:59, :61, :66–67, :103; .specs/engineering/checks/C-INS-05.md:3–4; validation-plan.md:141.

   **Finding:** Isolation per branch and atomic setup ownership do not cover two 'host start' or upgrade/restore processes contending for one $STATE, nor two macOS users competing for the default ports and launchd service. A race can start two PostgreSQL supervisors, regenerate the install key, migrate twice or point one browser at another team's existing listener. This is installer exclusion testing; it does not require adding a multi-install product feature.

   **Concrete fix text:** “Install owner runs 20 concurrent starts against the same state root, then start-vs-upgrade and start-vs-restore races. Require exactly one supervisor/PostgreSQL/migration owner, one unchanged install key and install identity, and either idempotent attachment or a typed busy refusal for losers. From a second macOS user, attempt installation with occupied ports: require clean refusal with no reads/writes to the first user's state. Test stale lock recovery after SIGKILL and path/symlink collisions without initializing over existing data.”

25. **blocker — Additional risk 10/10: the factory can count dogfood while continuing the side door or fail while modifying its own runtime.**

   **Plan section:** G-S1, G-REL-2; §3.2 G48; §7.

   **Evidence:** validation-plan.md:75, :89, :123, :187–193; gap-analysis.md:443; .specs/product/mvp.md:485, :547, :551–556, :562; .specs/engineering/overview.md:120–121; .specs/engineering/checks/C-REL-04.md:14, :25–26; .specs/engineering/spec.md:1216.

   **Finding:** G48 waits for 50 merges but no gate executes the M-31 cutover when S1's J1/J2 pass. The research requirement matrix omits M-31. Counting commits “without a TODO PR” does not detect work written on a laptop and imported into a TODO PR; it is a proxy for bypassed landing, not the specified laptop-fallback measure. No check makes the factory change its own flow/runtime, restart, recover in-flight work and continue on its Mac stack. Instrumentation postponed until S3 also loses the first two weeks' evidence.

   **Concrete fix text:** “Add G-DOGFOOD-START immediately after S1 J1/J2 qualification: named owner, Will's install/repository identity, cutover time, issue-sweep direct-main path disabled and a real Smithers change created/run/reviewed/person-merged on that stack. Record developer fallback and factory provenance from the start; do not equate ‘has TODO PR’ with ‘made inside Smithers.’ Run a self-change canary through flow activation and a packaged host restart, verifying pinned old runs, recovery receipts and the next TODO. G-REL-2 counts 50 distinct real TODO squash merges in a declared 14-day window, excludes QA-generated filler and reconciles laptop work. Define person-minutes and collect it before outside-team alpha; keep their later activation/retention/self-improvement verdicts pending until actual observations exist.”

26. **minor — The plan's version and count prose cannot identify the exact acceptance population.**

   **Plan section:** header; stage counts; §3 revalidation.

   **Evidence:** validation-plan.md:3, :70–80, :97; .specs/product/mvp.md:3; findings/LOG.md:7–12; .specs/engineering/checks/README.md:20.

   **Finding:** The plan says v2.8, while the supplied product header says v2.5 despite including M-34–M-36. It reports 112 checks, describes a 109-check index plus four additions, and quotes per-stage totals without a list that explains overlap. The checked tree does contain 112 C-* files; this is not evidence that an extra check is missing, but it shows prose counts cannot be the gate denominator. Research decisions marked “fixed on disk” or “ruled” are not automatically landed candidate evidence.

   **Concrete fix text:** “Pin the acceptance manifest to a source commit plus content hashes, derive unique and per-stage counts from explicit IDs, and distinguish proposed/on-disk/landed/qualified status. Reconcile version headers without inferring newer content from a version string. Re-run affected evidence when the check, spec or implementation identity changes.”

27. **major — W0 cannot require a positive result for a design that the accepted spike already rejected.**

   **Plan section:** §2 G-W0; §4 dependencies.

   **Evidence:** validation-plan.md:51, :74, :82; .specs/engineering/overview.md:86–89; .specs/engineering/checks/C-SPK-02.md:31–35; C-MCH-09.md:19–25; eng-progress.md:134; findings/LOG.md:10.

   **Finding:** G-W0 includes C-SPK-02 as an ordinary pass gate. Its positive oracle requires shared virtiofs homes and cross-VM visibility, while the engineering overview accepts the NO result and chooses per-machine homes because shared homes lost data. Treating the old experiment as a forever-red product gate makes W0 impossible; declaring it green to unblock the queue falsifies the receipt. The research also contains an explicitly retracted stale-copy finding about this spike, so it cannot be used as evidence against the current decision.

   **Concrete fix text:** “W0 requires RESOLVED experiment receipts: question, exact run environment, YES/NO outcome, limitations and the selected fallback. Preserve C-SPK-02's rejected result without calling it PASS. Qualify the adopted per-machine-home design through C-MCH-09/C-MCH-10 and applicable reference-host evidence. The tech lead updates stage dependencies and retired experimental oracles together; obsolete positive experiments do not block a safe adopted fallback.”

28. **major — The three changes needed before sending this plan to the leads are concrete and small enough to review.**

   **Plan section:** whole plan, especially §§2–4 and 7.

   **Evidence:** validation-plan.md:49–59, :82, :123, :137–147, :187–206; .specs/product/mvp.md:485, :560–572, :588–599; AGENTS.md:190–207.

   **Finding:** The leads currently have a research backlog, rather than a release decision procedure and an executable S1 campaign.

   **Concrete fix text:**

   - **First: replace the gate prose with one closed acceptance manifest.** Bind §2/§9/P0/§12, all required G/W repairs and the ten additional scenarios to stages, Sol workers, executable oracles and immutable evidence. Reconcile the outsider-admission and new M-34–M-36 rules immediately. Any missing/failed/skipped obligation blocks its gate, independently of severity.
   - **Second: replace the starvation loop with a runnable S1 evidence pipeline.** Give a named owner and date to hardware/account access, pin one candidate, reuse PostgreSQL and existing fault hooks, build the minimum GitHub fake plus a single-VM J1/J2 browser driver, run fast unit/integration coverage first, and bound heavy work. Five-minute polling schedules jobs; it does not promise to finish suites or repairs. No new parallel GitHub Actions factory is needed.
   - **Third: make the stage-1 safety and dogfood cutover real.** Add the migration/restore/disk-failure qualification and hostile-issue credential-boundary cases, then the M-31 cutover receipt and early telemetry. Run actual Smithers changes on Will's stack as soon as J1/J2 qualify. Keep full multiplayer/Yjs and later alpha outcomes at their prescribed stages; keep future maintainer-upgrade evidence explicitly pending until product resolves the launch timing and the real upgrade runs.

VERDICT: not ready — 9 blockers
