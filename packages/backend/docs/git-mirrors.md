---
title: "Git refs, backups and mirrors"
description: "Which refs a git client sees in a Smithers repository, and how to back it up or mirror it."
---

## What a clone sees

For one credential, fetches and pushes advertise the same refs, so a mirror clone pushes back only refs it can see. A workspace credential, a deploy key or an anonymous reader sees no user refs.

| Refs | Fetch | Push |
| --- | --- | --- |
| `refs/heads/*`, `refs/tags/*`, `refs/notes/*` | everyone with read access | write access; the default bookmark only moves forward |
| `refs/heads/mythical`, `refs/notes/mythical` | everyone with read access | the stack service only |
| `refs/smithers/workspaces/<id>/...` | everyone with read access | that workspace's credential only |
| `refs/smithers/users/<id>/...` | user `<id>` only | user `<id>` only |
| `refs/jj/*`, `refs/smithers/case-collision/*` | hidden | hidden |

Hiding is per ref name. It does not make objects secret: they share one object store.

## Back up

```sh
git clone --mirror https://<host>/<owner>/<repo>.git
git -C <repo>.git remote update --prune
```

Git mirror sync to GitHub copies every ref but `refs/smithers/*`, `refs/jj/*` and `refs/pull/*`.

## Restore or mirror into Smithers

`git push --mirror` from a current mirror clone works: it changes only the branches, tags and your own user refs that differ. A mirror push that would create, move or delete the stack or a workspace ref is refused whole, as from a stale clone or another host. Push branches and tags instead:

```sh
git push --prune <smithers-remote> 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*' '^refs/heads/mythical'
```

The stack service rebuilds the stack (`history.bootstrap`); workspace refs are recreated by their workspaces.
