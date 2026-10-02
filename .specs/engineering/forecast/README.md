# Stage 1 forecast: method

Version 2026-10-02 16:30 PT · Owner: engineering (smithers-8a)

The date for "stage 1 passes J1 and J2" comes from a Monte Carlo list scheduler over the real dependency graph in `tickets/README.md`, not from judgement.

```sh
python3 .specs/engineering/forecast/sched.py .specs/engineering/forecast/plan-of-record.json
```

**Scope.** The transitive dependency closure of the tickets that C-J1-01..06 and C-J2-01..05 name (41 tickets on 2026-10-02).

**Inputs.** All inputs were measured on 2026-10-02 unless marked as a prior.
- First-pass hours per size (P50/P90): S 0.75/1.5, M 1.5/3.5, L 4/9. Source: smithers-22's lanes. In-flight tickets are censored at their elapsed hours.
- Review is a serial resource. A round takes 0.75/1.5 h and a fix 0.6/1.5 h. The number of rounds is 1 plus a geometric count at the review yield.
- Ready pre-review adds 0.5–1.5 h per ticket.
- CI gives no per-landing verdict today (QA), so each landing carries 0.5–1.5 h of local verification.
- First end-to-end integration debugging takes 10/30 h (QA's prior).
- Lanes: 6 local, plus 6 GKE from Sat Oct 3 18:00. Design is 1 lane from Sat Oct 3 08:00.

**Results (2026-10-02 16:25 start).**

| Scenario | Review yield | Reviewers | P50 | P90 |
| --- | --- | --- | --- | --- |
| Today's trajectory | 0.2 | 2 | Sat Oct 10 | Mon Oct 12 |
| Plan of record | 0.35 | 2 | Wed Oct 7 | Thu Oct 8 |
| More review capacity | 0.35 | 4 | Tue Oct 6 | Wed Oct 7 |
| Higher yield | 0.5 | 4 | Mon Oct 5 | Tue Oct 6 |

**Finding.** Review yield and review concurrency set the date. Dropping to 4 local lanes moves nothing, and all accepted critical-path cuts together save under one day.

**Not modeled.** Each of these is a gate tracked elsewhere: SSH access to the reference Mac mini, the canary org and test accounts, main CI red (#3071), and mid-flight scope changes, which the freeze rule now prevents.

**Limitations.** Lanes are modeled as working around the clock. Owner availability at night is not modeled. Sizes come from five reviewed first passes, so the sample is small. Re-run the scheduler with new measurements as tickets land.
