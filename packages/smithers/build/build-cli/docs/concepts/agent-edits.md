---
title: "Accepted agent edits"
description: "How accepted agent edits are published safely in the workspace."
---

`Agent.Lint --fix` and accepted `Agent.Diff` candidates publish through the
same local applier under write-set enforcement. Each replacement is staged
beside its destination and renamed into place, preserving existing file
permissions. Replacement requires a writable parent directory; the destination
file itself may be read-only. Other hard links to the old file keep their original bytes.

Before publication, the applier checks the entire candidate for changed
path identities and symlinked components. A rejected commit fails the run;
write-set enforcement restores prior file bytes after a failed publication.
