# Stage 1 forecast: method

Version 2026-10-02 17:50 PT · Owner: engineering (smithers-8a)

The date for "stage 1 passes J1 and J2" comes from a Monte Carlo list scheduler over the real dependency graph in `tickets/README.md`, not from judgement.

```sh
python3 .specs/engineering/forecast/sched.py .specs/engineering/forecast/plan-of-record.json
```

**Scope.** The transitive dependency closure of the W0/S1 tickets that C-J1-01..06 and C-J2-01..05 name: 71 tickets at 17:50, up from 50 at 16:50. The integration pass made every check list the tickets whose Acceptance cites it, and 22 more S1 tickets cite a J1 or J2 check. A staged Depends (`S1: a · S2: b`) contributes only its W0/S1 segments to this forecast; before 17:50 the model followed every segment and wrongly pulled the S2 co-edit chain into stage 1.

**Inputs.** All inputs were measured on 2026-10-02 unless marked as a prior.
- First-pass hours per size (P50/P90): S 0.75/1.5, M 1.5/3.5, L 4/9. Source: smithers-22's lanes. In-flight tickets are censored at their elapsed hours.
- Review is a serial resource. A round takes 0.75/1.5 h and a fix 0.6/1.5 h. The number of rounds is 1 plus a geometric count at the review yield.
- Ready pre-review adds 0.5–1.5 h per ticket.
- CI gives no per-landing verdict today (QA), so each landing carries 0.5–1.5 h of local verification.
- First end-to-end integration debugging takes 10/30 h (QA's prior).
- Lanes: 6 local, plus 6 GKE from Sat Oct 3 18:00. Design is 1 lane from Sat Oct 3 08:00.

**Results (2026-10-02 16:50 start, closure as of 17:50).**

| Scenario | Review yield | Reviewers | P50 | P90 |
| --- | --- | --- | --- | --- |
| Today's trajectory | 0.2 | 2 | Thu Oct 15 | Sat Oct 17 |
| Two reviewers | 0.35 | 2 | Sat Oct 10 | Sun Oct 11 |
| **Plan of record** (product, 17:55) | 0.35 | 4 | Wed Oct 7 | Thu Oct 8 |
| Higher yield | 0.5 | 4 | Tue Oct 6 | Wed Oct 7 |

Product made 4 concurrent reviewers the plan of record at 17:55; `y035-r4.json` is that scenario and `plan-of-record.json` keeps the 2-reviewer inputs. At 16:50 the 2-reviewer scenario gave Thu Oct 8. The 21 added tickets cost two days with 2 reviewers and nothing with 4: review concurrency absorbs them.

**Launch-ready tickets (M-37).** After stage 1, all sizes run as TODOs on the install by default. Each outside exception is recorded per ticket with an owner, reason and expiry; every outside merge and its effort is reported daily (C-REL-04). The existing launch forecast files exempt L tickets and must be regenerated before use; ticket size grants no exception.

| Install machines | P50 | P90 |
| --- | --- | --- |
| 2 | Wed Oct 14 | Fri Oct 16 |
| 5 (reference host: 64 GiB, 10 performance cores, 208 GiB free) | Wed Oct 14 | Fri Oct 16 |

Machines are not the constraint after M-31; review is. Launch is bounded by stage 1 plus 14 days of dogfood (M-31): about Oct 21–22 on this model. Fable's independent estimate is Nov 13.

**Finding.** Review yield and review concurrency set the date. Dropping to 4 local lanes moves nothing, and all accepted critical-path cuts together save under one day.

**Not modeled.** Each of these is a gate tracked elsewhere: the canary org and test accounts, main CI red (#3071), and mid-flight scope changes, which the freeze rule now prevents.

**Limitations.** Lanes are modeled as working around the clock. Owner availability at night is not modeled. Sizes come from five reviewed first passes, so the sample is small. Re-run the scheduler with new measurements as tickets land.
