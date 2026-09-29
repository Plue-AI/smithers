---
title: Repository configuration sync
description: File requirements and failure behavior for repository configuration sync.
---

Repository configuration is read from `.smithers/config.yml`,
`.smithers/protected-bookmarks.yml`, `.smithers/labels.yml`, and
`.smithers/webhooks.yml` at the requested commit.

Sync requires complete UTF-8 text. If any present file exceeds the repository
host's read limit (16 MiB for the native host), reports a read error, or uses an
unsupported transport encoding or mismatched path, the entire sync fails before applying changes.
Existing repository settings, bookmark protections, labels, and webhooks remain
unchanged. Dry runs reject the same unreadable files.

Reduce an oversized file and retry with the new commit. An absent file leaves
its settings unchanged; a readable, empty protection or webhook file
intentionally clears that collection. An empty labels file removes unused
labels; labels attached to issues remain with a warning.

A failed configuration sync does not reject the push. It records a `config.sync`
audit event with action `failed` and a server log entry.
