---
title: "Repair legacy ref names"
description: "Repair legacy Git ref names that block canonical bookmarks and verify the result."
---

## Automatic repair

Every API worker start scans repositories for legacy refs that differ only in
case or ignored characters. Repo-host repairs variants of `mythical`, the default
bookmark, and protected bookmarks whose canonical spelling is unambiguous.
It removes mythical variants even when the canonical ref is missing. It renames
exactly one variant to a missing default bookmark, or removes variants of an
existing default bookmark. A protected collision is repaired only when exactly one
existing spelling matches its protection pattern; that spelling is kept.
It never creates a missing mythical ref from a variant, even when a legacy
default bookmark names `mythical` or one of its variants. A group entirely nested
under variants of the same reserved name is removed when that reserved ref is
missing, and reported when it exists. Mixed groups containing a canonical
directory spelling remain unchanged and are reported. Other collisions also
remain unchanged and are reported.

Each changed variant retains a numbered backup under
`refs/smithers/case-collision/<timestamp>/<number>/`. These refs are hidden from
Git fetch and push advertisements. Repair runs under the repository write lock,
preserves existing canonical values on case-insensitive filesystems, and imports
the result into jj before returning success. Import failures fail the request;
any variants already changed keep their backups. Repeating a successful repair
creates no additional backups.

The authenticated repo-host endpoint is
`POST /repos/{id}/ref-case-collisions/repair`, with an optional
`protected_patterns` array. Its response lists refs, canonical names, actions and
backup refs. The API worker supplies the repository's stored protection rules.

## Verify completion

Worker logs include one `ref case collision` record per collision and a
`ref case collision repair completed` record with repository, affected,
collision, removed, renamed, reported, missing and failed counts.

A missing completion record, including when a worker exits during the scan,
does not establish a successful repair. A completion record with a nonzero
`failed` count also requires investigation. Resolve each failure before
restarting a worker to retry. Failures can include unavailable storage routing, database errors or
repository refusals. Missing stores are counted separately. Review reported
collisions individually and preserve their objects before removing or renaming
refs. Changes to reserved refs require the control plane.

Retain the deployed image identity, completion counts and collision records.
For an affected repository, verify that canonical bookmarks are usable, backup
refs retain the previous objects, and a second repair changes nothing. A source
commit or deployment acknowledgment alone does not prove those checks passed.
