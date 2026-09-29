# Linear sync status

`last_sync_at` records the last successful Linear sync activity, not the last attempt. An initial import updates it only after every issue returned by its Linear query is imported or found in the existing mapping. The query pages through open issues in groups of 100. A failed import does not advance the timestamp and marks the tracked run failed with its completed and failed issue counts. Retrying the import reuses existing mappings. Successful inbound webhook handling can also advance `last_sync_at` independently of an initial import.

The integration API returns `last_sync_at`; the run API reports each attempt's state and counts. A failed run can therefore be newer than the last successful timestamp.
