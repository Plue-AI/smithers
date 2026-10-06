---
title: "Upgrade recovery guards"
description: "Lifecycle port sources for the Mac install."
---

T-INS-07 owns Mac upgrade recovery. Scripts and regression tests in `distribution/` remain port sources only. Preserve failed state and verified backups. Never clear an incomplete-upgrade marker to bypass a guard.
