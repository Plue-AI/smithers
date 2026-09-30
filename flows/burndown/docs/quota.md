---
title: "Account quota"
description: "Quota evidence and conservative worker capacity."
---

## Idle windows

Claude's explicit zero-use window with a null reset is idle. Its reset remains
null in readings and capacity receipts. Pacing uses the declared window duration,
bounded by the burn horizon, while every weekly window and running worker still
constrains available slots. A later observation can supply the real reset.

Nonzero use with a null reset, malformed quota, expired windows and failed reads
cannot authorize workers. Retained last-good usage is diagnostic evidence only;
a failed current read cannot prove quota hard stop or exhaustion. Reset waits
use only real future reset timestamps.
