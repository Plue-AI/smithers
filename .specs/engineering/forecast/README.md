# Stage 1 forecast: method

Version 2026-10-02 19:00 PT · Owner: engineering (smithers-8a)

The date for "stage 1 passes J1 and J2" comes from a Monte Carlo list scheduler over the real dependency graph in `tickets/README.md`, not from judgement.

```sh
python3 .specs/engineering/forecast/sched.py .specs/engineering/forecast/plan-of-record.json
```

**Scope.** The transitive dependency closure of the W0/S1 tickets that C-J1-01..06 and C-J2-01..05 name: 86 tickets at 19:00, up from 71 at 17:50 and 50 at 16:50. The Ready wave made every ticket name its landing preconditions, and T-STK-04 (M-39) joined. A staged Depends (`S1: a · S2: b`) contributes only its W0/S1 segments.

**Inputs.** All inputs were measured on 2026-10-02 unless marked as a prior.
- First-pass hours per size (P50/P90): S 0.75/1.5, M 1.5/3.5, L 4/9. Source: smithers-22's lanes. In-flight tickets are censored at their elapsed hours.
- Review is a serial resource. A round takes 0.75/1.5 h and a fix 0.6/1.5 h. The number of rounds is 1 plus a geometric count at the review yield.
- Ready pre-review adds 0.5–1.5 h per ticket.
- CI gives no per-landing verdict today (QA), so each landing carries 0.5–1.5 h of local verification.
- First end-to-end integration debugging takes 10/30 h (QA's prior).
- Lanes: 6 local, plus 6 GKE from Sat Oct 3 18:00. Design is 1 lane from Sat Oct 3 08:00.

**Results (closure as of 19:00; 2026-10-02 start).**

| Scenario | Review yield | Reviewers | P50 | P90 |
| --- | --- | --- | --- | --- |
| Today's trajectory | 0.2 | 2 | Mon Oct 19 | Thu Oct 22 |
| Observed yield, more reviewers | 0.2 | 4 | Thu Oct 15 | Sat Oct 17 |
| Two reviewers | 0.35 | 2 | Tue Oct 13 | Wed Oct 14 |
| **Plan of record** (product, 17:55) | 0.35 | 4 | Sun Oct 11 | Mon Oct 12 |
| Higher yield | 0.5 | 4 | Fri Oct 9 | Sat Oct 10 |

At 17:50 the plan of record gave Wed Oct 7 / Thu Oct 8. The four-day slip is the 15 added closure tickets, not new estimates.

**Review yield is the risk.** First-pass yield so far is 0 of 6. Reaching the plan's 0.35 over the first ten needs all four of the next first passes to succeed; one more failure makes the plan of record unreachable and the "observed yield" row the working forecast (Will's org review, 18:5x).

**Launch-ready tickets (M-37, revised 2026-10-02).** `launch-5m-*.json` schedule every W0–R ticket. After stage 1, every ticket runs as a TODO on the install's 5 machines (reference host: 64 GiB, 10 performance cores); a ticket runs outside only when it is listed in `post_exceptions` with an owner, a reason and an expiry recorded on the ticket. There is no size exemption.

| Review yield | Reviewers | All tickets landed P50 | P90 |
| --- | --- | --- | --- |
| 0.2 | 2 | Mon Nov 2 | Thu Nov 5 |
| 0.2 | 4 | Wed Oct 21 | Sat Oct 24 |
| 0.2 for 48 h, then 0.35 | 4 | Fri Oct 16 | Sun Oct 18 |

**Launch** is the later of "all tickets landed" and "stage 1 + 14 days of dogfood" (M-31):

| Scenario | Stage 1 P50 | + 14 days | All landed P50 | Launch P50 |
| --- | --- | --- | --- | --- |
| Plan of record (0.35, 4 reviewers) | Oct 11 | Oct 25 | Oct 16 | **Sun Oct 25** |
| Observed yield, 4 reviewers | Oct 15 | Oct 29 | Oct 21 | **Thu Oct 29** |
| Observed yield, 2 reviewers | Oct 19 | Nov 2 | Nov 2 | **Mon Nov 2** |

The dogfood bound sets launch in every scenario except the last. Fable's independent estimate is Nov 13. M-39 removes human merge latency from our own TODOs; the model never charged it, so the dates don't move.

**Not modeled.** Each of these is a gate tracked elsewhere: the canary org and test accounts, main CI red (#3071), and mid-flight scope changes, which the freeze rule now prevents.

**Limitations.** Lanes are modeled as working around the clock. Owner availability at night is not modeled. Sizes come from five reviewed first passes, so the sample is small. Re-run the scheduler with new measurements as tickets land.
