---
title: "Git LFS repository visibility"
description: "Repository visibility and upload verification permissions for Git LFS."
---

Git LFS batch requests for a private repository return `404` when the caller cannot read it. The response is the same as for a repository that does not exist, for both uploads and downloads. A caller who can read the repository still needs write permission to upload.

Upload verification at `POST /api/repos/{owner}/{repo}/lfs/verify` also returns the same `404` status, code, and message for missing and unreadable private repositories. This applies to signed-in users, tokens with `write:repository`, and LFS credentials bound to another repository. Anonymous verification requires authentication (`401`). A caller who can read a repository still needs write permission to confirm an upload (`403` otherwise); a scoped verification credential must match the repository, object ID, and size.
