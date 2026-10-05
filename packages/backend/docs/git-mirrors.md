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

A push names refs under `refs/` in git's ref format. A push that names `HEAD`, another pseudoref such as `FETCH_HEAD`, or a bare name is refused with `400` before git runs, whoever sends it. A push whose new refs would grow the repository's ref listing past 64 MiB is refused with `413 push_too_large` before git applies anything.

A push refused after git applied it is rolled back. The rollback writes each ref by its own name, never through a symbolic ref. When it cannot finish, or the refs the push left cannot be listed, every write to the repository fails with `503 repository_rollback_held`; reads still work. The file `smithers-rollback-hold` in the repository's git directory records when and why. Restore the refs, then delete the file; writes resume at once.

On an install, `main` and the default bookmark belong to the GitHub sync, which only fast-forwards them. Every push, bookmark write, landing and ref repair that would create, move or delete either is refused with `403 permission`. A GitHub rewrite of `main` waits for the owner's reset: the import that would copy it fails with the rewrite, also when the mirror's `main` moved after the import compared it. When GitHub's default branch stops being `main`, every import fails with `default_branch_not_main` and leaves `main` as it is. An install's mirror holds no replacement refs (`refs/replace/*`): its first import drops GitHub's.

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

## Interrupted GitHub reconciliation

Reconciliation and individual ref retries have ten minutes from acceptance to
finish. After another minute for cancellation, interrupted runs become failed
and release the repository for a new request. Recovery runs when workers start,
every minute, and when a caller polls or retries. Existing active runs use the
same deadline.

Pending ref results become failed; verified results and the last verified GitHub
head remain available. A late worker cannot overwrite the interrupted receipt or
newer mirror health. Retry reconciliation to read the current refs and obtain
fresh credentials. Recovery does not replay Git pushes: an interrupted push may
have reached GitHub before its verification was recorded.
