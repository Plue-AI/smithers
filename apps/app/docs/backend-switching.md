---
title: "Switching backends"
description: "Credential handling when changing the app's backend."
---

## Failed switches

Backend selection lasts for the current tab or window. A switch validates the
new backend before changing storage, then removes the previous credential before
saving the new backend and credential.

A Plue token can select the serving origin, including an empty backend address.
The app sends those requests to the page origin. An external Plue address uses
credentialed CORS.

If browser storage refuses an operation, the switch fails. The previous backend
may remain selected with or without its credential, or the new backend may be
selected without a credential;
credentials never move between backends. Retry the switch with the intended
backend and credential after storage becomes available.
