---
title: "Native file outputs"
description: "Workspace output admission and publication for Fetch, Copy, and Literal."
---

## Native file outputs

`S.Fetch`, `S.Copy`, and `S.Literal` admit output parents before creating
directories or files. Directory symlinks and symlink destinations are refused;
use an ordinary workspace directory. A refused output leaves existing external
bytes and missing external directories untouched. Accepted outputs are staged
in their destination directory and published only after writing succeeds;
Fetch also verifies its SHA-256 before publication.

A Fetch in the root `PACKAGE.ts` writes its package-relative `out` path from
the workspace root, just as a Fetch in a nested package writes from that package.
