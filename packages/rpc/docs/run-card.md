---
title: "Recorded runs"
description: "Persisted run contracts and historical decoding."
---

`PlanCardNodeSchema` and `PlanCardGraphSchema` describe plan nodes, edges and optional pinned source revisions. `GraphDrawerSchema` stores the selected node, evidence tab and optional code-read failure.

`LegacyRunTracePayloadSchema` preserves recorded run phases, journal projections, plan snapshots and observation state. The retired forks filter decodes to all. `MonitorCardSchema` and `RunViewStateSchema` are re-exported from MonitorCard for current views.
