---
title: "Pinned execution source"
description: "Resume approved local module code after a host restart or source edit."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/guides/pinned-execution-source.md"
---

## Resume an approved module

At first admission, Smithers publishes the module's verified local closure to
`.flows/objects`. A manifest records its execution digest, entry, each module's
artifact digest, and the project lockfile digest. The execution digest index
lives in `.flows/executions`.

After a host restart, `smthrs runs resume <id>` loads the approved entry, helpers,
and implementation layer from those artifacts when the live source differs.
The loader uses the same private sibling imports as the initial execution.
Completed steps retain their durable receipts.

A missing snapshot or changed project lockfile still returns `CodeDrift` before
claiming the run. Restore the snapshot and dependencies, or explicitly adopt the
current code with `smthrs runs resume <id> --allow-code-drift`.

A host registers one version per flow name. Adopting changed code refuses while
another non-terminal control run uses that name.

Installed packages, including workspace packages, are host code and are not
snapshotted. Run long-lived hosts from a pinned checkout with its installed
lockfile. Keep `.flows/executions` with `.flows/objects` when moving durable
state.

## Collection

`smthrs gc` treats manifests and module artifacts referenced by non-terminal
runs as roots. Existing ancestry also retains an owning run's snapshot while a
native descendant remains active. A dependency change does not remove these
roots. Terminal, unreferenced snapshots become eligible for the artifact grace
period; collection remains explicit.
