---
title: "Application requests"
description: "Error precedence for application HTTP requests."
---

`ApplicationClient.stream()` and `request()` classify an aborted read of a
non-2xx response body as `cancelled`. The error retains the body-read failure
as its cause. If the body is malformed without cancellation, the HTTP status
still determines the error code and the status remains available.
