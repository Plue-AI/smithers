---
title: "Ownership approvals"
description: "How repository ownership rules protect changes before landing."
---

## Repository paths

Ownership rules apply to the exact repository path, including leading and
trailing whitespace in file and directory names. For example, ` secret/OWNERS`
governs ` secret/file.go`; `secret/OWNERS` governs a different directory.

Required owner approvals and `agents: deny` apply both when landing is requested
and when the landing worker checks the change. A root `agents: auto-land` rule
does not override a matching directory's `agents: deny` rule.
