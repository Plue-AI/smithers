---
title: "Agent environment"
description: "Repository setup script, variables, secrets, and request size limits."
---

## Update a repository environment

`PUT /api/repos/{owner}/{repo}/agent-environment` accepts one JSON document with `setup_script`, `env`, and optional `secrets`. The setup script is limited to 1 MiB of UTF-8, and each variable or secret value to 64 KiB. A document can contain up to 100 variables and 100 secrets.

The combined request body is limited to 16 MiB, including JSON escaping and field names. The limit is inclusive. A larger body returns HTTP 413 at the Worker or backend before storage changes. Direct service calls also reject more than 16 MiB of decoded string content. Shorten values or split secrets into separate secret writes when a document exceeds the limit.

Other Worker proxy writes retain their 256 KiB limit. Backend JSON routes retain their 1 MiB default limit.
