# QA spec: Smithers MVP validation

Owner: lead QA (smithers-4c). Product: [../product/mvp.md](../product/mvp.md). Engineering checks: [../engineering/checks/](../engineering/checks/README.md).

| File | What it is | Read when |
| --- | --- | --- |
| [validation-plan.md](validation-plan.md) | Gate model: closed requirement manifest, status vocabulary, gates on one pinned candidate, harness order, release index, dogfood gate | Before claiming any ticket, stage or release is done |
| [findings.md](findings.md) | Every QA finding with owner and status | To see what QA found and where it went |
| [ahead/](ahead/) | Test plans written before a ticket's lane starts (oracle tables, layers, abuse cases, spec gaps) | When a lane starts that ticket |
| [research/](research/) | Gap analysis (288 requirements traced), test-infra inventory, CI triage, pepper reports, Codex reviews of this plan | To verify a claim in the plan |

Rules that override convenience:
- A gate passes only with PASS evidence for every mandatory row on one pinned SHA. FAIL, BLOCKED, SKIPPED and NOT IMPLEMENTED reject it, whatever the severity.
- A lane report never closes a ticket; QA's re-run from main does.
- Every bug found marks a weak defect class: Sonnet agents pepper the class with tests, Sol agents fix, and clusters go to the tech lead for a Fable architecture review.
