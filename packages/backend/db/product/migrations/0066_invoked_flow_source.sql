-- An invoked run records which source it ran. trigger_commit is the commit
-- the run's trigger_ref named when the flow file was found there at
-- invocation; source_revision is the box snapshot the Flow host actually
-- read. The host runs the invoker's box working copy, so the two can differ.
ALTER TABLE workflow_run_flow_invocations
    ADD COLUMN trigger_commit TEXT NOT NULL DEFAULT '',
    ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
