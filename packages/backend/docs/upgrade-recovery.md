---
title: "Recover a failed self-host upgrade"
description: "Restore the verified pre-upgrade backup without overwriting the failed installation."
---

## Mac install recovery

The install uses `smthrs host backup`, `smthrs host upgrade` and
`smthrs host restore` as specified in T-INS-07. Their implementation and
qualification remain pending. See the [install service instructions](../../../apps/app/scripts/README.md#stage-1-service).

The lifecycle scripts under `distribution/` and their guard tests remain
port sources for T-INS-07. They are not shipped in the ephemeral preview
image, which has no durable state or recovery path.
