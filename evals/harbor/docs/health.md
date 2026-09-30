---
title: "Benchmark health"
description: "Report every retained trial, placement refusal and verifier failure."
---

```bash
python3 -B evals/harbor/health.py <jobs-directory> <report.md> <job-name>
```

The report counts all current trials, including running trials, placement
refusals and infrastructure failures. Solved trials use that complete
denominator. Scored trials are listed separately; a refusal or verifier failure
never becomes a score, even when its result contains a reward.

Each placement refusal retains its trial, task and exception message. Retried
attempts in `<job-name>.infra` remain in the recent infrastructure check but do
not count again in the current trial denominator. A health exit of `0` does not
prove every task placed or that a benchmark is complete.

Keep the original job and task roster when qualifying resources. The four
placement requirements are tracked in
[#2262](https://github.com/smithersai/smithers/issues/2262):
[sidecars #2467](https://github.com/smithersai/smithers/issues/2467),
[CPU #2468](https://github.com/smithersai/smithers/issues/2468),
[GPU #2469](https://github.com/smithersai/smithers/issues/2469) and
[disk #2470](https://github.com/smithersai/smithers/issues/2470).
Full paired scoring and verifier health remain in
[#1917](https://github.com/smithersai/smithers/issues/1917).
