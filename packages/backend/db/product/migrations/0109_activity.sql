-- Branch activity (spec §3, §7.2 branch:<id>:activity; T-STK-01). One entry
-- per agent step, steer, question, answer, burst of edits, change, GitHub
-- event or rebase, numbered per branch in commit order. S1 writes agent
-- steps (from the runtime projection), steers (T-STK-06), answers (T-STK-07)
-- and GitHub comments (T-GH-04); burst_id, snapshot_before, snapshot_after
-- and files stay null until S2 (T-COL-04).
CREATE TABLE activity (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id uuid NOT NULL REFERENCES todos(branch_id) ON DELETE CASCADE,
    seq bigint NOT NULL CHECK (seq > 0),
    at timestamptz NOT NULL DEFAULT now(),
    actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
    asked_by jsonb CHECK (asked_by IS NULL OR jsonb_typeof(asked_by) = 'object'),
    kind varchar(8) NOT NULL CHECK (kind IN ('step', 'steer', 'question', 'answer', 'edit', 'change', 'github', 'rebase')),
    summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
    burst_id uuid,
    snapshot_before text,
    snapshot_after text,
    files integer CHECK (files IS NULL OR files >= 0),
    github boolean NOT NULL DEFAULT false,
    -- The writer's identity for the entry (for an agent step, the run and its
    -- journal sequence), so a re-observed runtime page appends nothing twice.
    source_key text,
    UNIQUE (branch_id, seq)
);

CREATE UNIQUE INDEX activity_source_key_idx ON activity (branch_id, source_key) WHERE source_key IS NOT NULL;
