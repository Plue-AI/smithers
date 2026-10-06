-- Branch conversations have one host-owned journal in chat_turns.
-- Earlier reads chat_turns and persisted browser history, never these tables.
DROP TABLE app_timeline_branches, app_timeline_events, app_timeline_members,
           app_timeline_snapshots, app_timelines;
