-- The kind of credential behind each push (middleware.CredentialKind): a
-- person's, an agent run's, the platform's GitHub sync, or the platform's own
-- verified write (the GitHub main pull). Only a person's push and the
-- platform's own write start runs that record push; every other push,
-- unattributed events recorded before this column included, starts runs that
-- record system_push and save no workflow cache.
ALTER TABLE public.repo_push_events
    ADD COLUMN pusher_credential text NOT NULL DEFAULT ''
        CHECK (pusher_credential IN ('', 'person', 'run', 'sync', 'platform'));
