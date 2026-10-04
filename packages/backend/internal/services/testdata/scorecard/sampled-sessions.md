# C-REL-04 annotation fixtures

Synthetic arithmetic examples for alpha-owner review, not observations or an
owner-signed manual receipt. The API never reads this file. Times below are
minutes from the beginning of each sampled session. Intervals are half-open.
Sampling method for this fixture: one selected TODO each week; the remaining
29 accepted TODOs each week are unsampled, with no assigned effort.

| Week | TODO | Person | Answer | Review | Edit | Union minutes |
| --- | --- | --- | --- | --- | --- | ---: |
| 1 | A | Alice | [0,4) | [3,6) | [8,10) | 8 |
| 1 | A | Ben | [1,5) | — | — | 4 |
| 2 | B | Alice | [0,4) | [3,6) | — | 6 |
| 2 | B | Ben | — | [2,6) | — | 4 |

A: Alice's overlapping answer/review union is [0,6), plus [8,10): 8.
Ben contributes 4 even though his clock overlaps Alice's. Total 12.
B: Alice contributes 6, Ben 4. Total 10. Each week's sample size is 1,
so weekly medians are 12 then 10: below 15 and falling. Autonomous work
contributes no person intervals; a confirming person remains a person.

| Variant | Week 1 median | Week 2 median | Separate effort conclusion |
| --- | ---: | ---: | --- |
| Baseline | 12 | 10 | Target met; no rising-median kill |
| Exact boundary: B also has Alice edit [6,11) | 12 | 15 | Target fails (<15 is strict); rising-median kill |
| Rising: A omits edit; B adds Alice edit [6,8) | 10 | 12 | Target met; rising-median kill |
| No annotations | unmeasured | unmeasured | No effort verdict |

Changing the code-authorship diagnostic from 43/52 to 0/52 changes none of
these conclusions. A week-2 accepted count of 2 independently kills core
value. Automated accepted-count pass alone cannot prove the manual effort
half of core value. Actual alpha evidence still requires a documented
sampling method, sample size, unsampled TODOs and alpha-owner review.
