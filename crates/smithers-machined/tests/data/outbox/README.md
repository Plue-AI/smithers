# Persisted outbox fixtures (C-DUR-05)

`legacy` is release N's headerless file-per-entry layout. `v1` is the
current release's snapshot, retained as the next release's migration input.
Both contain captured events at seq 3 and 4, event IDs 03×16 and 04×16,
and a deleted/acknowledged high-water mark of 2. Pending Git refs belong to
the repository, not these files; the integration test pins both captured OIDs.
Tests install these bytes with owner-only directory/file permissions.

`FORMAT` is exactly the 15-byte ASCII magic `SMITHERS-OUTBOX` plus NUL,
then a four-byte big-endian version. Any persisted layout change increments
the version, independently of the wire protocol. Version 1 adds this header
to the legacy layout without changing event bytes or refs. Publish by fsync
of FORMAT.tmp, rename to FORMAT, and fsync of the directory. Interrupted
migration resumes from the unchanged legacy payloads. Never decode or clean
up files before refusing an unknown or malformed existing header.

`newer.header` is version 3 (N+2); `corrupt.header` is truncated.
