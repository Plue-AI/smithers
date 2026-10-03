-- TODOs (spec §2, §3, §4.1; T-STK-01). A TODO is one stack item with its own
-- number T<n>, append-only prompt revisions and a stored state. Every state
-- change appends one todo_events row; reads never infer a state that has no
-- event (§3.2). mythical_items stays the stack engine's work record and
-- links its TODO 1:1 (E-07); the engine projects its 15 item states onto the
-- nine TODO states in the same transaction as the item change (§4.1.0).

CREATE TABLE todos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    -- Sequential per repository with no gap (T1, T2, ...). An install serves
    -- one repository, so the topic todo:<n> names one TODO there.
    number bigint NOT NULL CHECK (number > 0),
    title text NOT NULL CHECK (title <> '' AND char_length(title) <= 256),
    state varchar(16) NOT NULL
        CHECK (state IN ('queued', 'starting', 'working', 'needs_you', 'paused', 'failed', 'in_review', 'merged', 'dropped')),
    state_reason text NOT NULL DEFAULT '',
    -- The member who owns the TODO (spec §2: members, not users).
    owner_id bigint REFERENCES members(id) ON DELETE SET NULL,
    issue_number bigint CHECK (issue_number IS NULL OR issue_number > 0),
    fixes_issue boolean NOT NULL DEFAULT false,
    -- Dense ordering key, compared byte-wise. T-STK-01 writes append keys only
    -- (twelve zero-padded digits); T-STK-02 inserts between keys.
    stack_position text COLLATE "C" NOT NULL CHECK (stack_position <> ''),
    -- An item owns its branch facts; no separate branch-centric table.
    branch_id uuid UNIQUE,
    branch_name text NOT NULL DEFAULT '',
    github_branch text CHECK (github_branch IS NULL OR github_branch <> ''),
    CHECK ((branch_id IS NULL AND branch_name = '') OR (branch_id IS NOT NULL AND branch_name <> '')),
    pr_number bigint CHECK (pr_number IS NULL OR pr_number > 0),
    created_by_actor jsonb NOT NULL CHECK (jsonb_typeof(created_by_actor) = 'object'),
    flow_name text NOT NULL DEFAULT 'todo',
    flow_digest text,
    merging jsonb,
    needs_you jsonb CHECK (needs_you IS NULL OR jsonb_typeof(needs_you) = 'object'),
    failure jsonb CHECK (failure IS NULL OR jsonb_typeof(failure) = 'object'),
    queue jsonb CHECK (queue IS NULL OR jsonb_typeof(queue) = 'object'),
    current_step text,
    lessons integer NOT NULL DEFAULT 0 CHECK (lessons >= 0),
    merged_at timestamptz,
    dropped_at timestamptz,
    -- Optimistic concurrency: every write is conditional on the version read.
    version bigint NOT NULL DEFAULT 0,
    -- POST /api/todos idempotency (spec §6.2.1): the creator's key and a
    -- digest of the request it named, so a repeat answers the first TODO and
    -- a reused key with another request is refused.
    create_key text,
    create_digest text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((create_key IS NULL) = (create_digest IS NULL)),
    UNIQUE (repository_id, number)
);

CREATE INDEX todos_stack_idx ON todos (repository_id, stack_position);
-- A creator without a person (the stack itself) shares one key space, so a
-- repeated key never makes a second TODO.
CREATE UNIQUE INDEX todos_create_key_idx ON todos (repository_id, (created_by_actor ->> 'person'), create_key)
    NULLS NOT DISTINCT WHERE create_key IS NOT NULL;

-- Prompt revisions are append-only: revision 1 is the original, an amend
-- appends n+1 (T-STK-02).
CREATE TABLE todo_revisions (
    todo_id uuid NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    rev integer NOT NULL CHECK (rev > 0),
    prompt text NOT NULL,
    acceptance text NOT NULL DEFAULT '',
    seed_patch_blob text,
    author_actor jsonb NOT NULL CHECK (jsonb_typeof(author_actor) = 'object'),
    reason varchar(16) NOT NULL CHECK (reason IN ('create', 'amend', 'from-issue')),
    issue_digest text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (todo_id, rev)
);

-- One row per state change, numbered per TODO. kind is the transition's
-- trigger; from_state is 'draft' for the placement that creates a TODO and
-- NULL only for the rows this migration imports.
CREATE TABLE todo_events (
    id bigserial PRIMARY KEY,
    todo_id uuid NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    seq bigint NOT NULL CHECK (seq > 0),
    at timestamptz NOT NULL DEFAULT now(),
    actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
    kind text NOT NULL CHECK (kind <> ''),
    from_state varchar(16)
        CHECK (from_state IS NULL OR from_state IN ('draft', 'queued', 'starting', 'working', 'needs_you', 'paused', 'failed', 'in_review', 'merged', 'dropped')),
    to_state varchar(16) NOT NULL
        CHECK (to_state IN ('queued', 'starting', 'working', 'needs_you', 'paused', 'failed', 'in_review', 'merged', 'dropped')),
    payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
    UNIQUE (todo_id, seq)
);

-- Durable TODO waits. This ticket only settles them when the work ends;
-- opening, answering and primary-wait ranking arrive with T-STK-13.
CREATE TABLE todo_waits (
    wait_id text PRIMARY KEY CHECK (wait_id <> ''),
    todo_id uuid NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('question', 'approval', 'conflict', 'moved_off', 'foreign_push')),
    owner text NOT NULL CHECK (owner IN ('run', 'branch')),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    run_wait_id text,
    opened_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    settled_by jsonb CHECK (settled_by IS NULL OR jsonb_typeof(settled_by) = 'object'),
    outcome text,
    CHECK ((settled_at IS NULL AND settled_by IS NULL AND outcome IS NULL)
        OR (settled_at IS NOT NULL AND settled_by IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX todo_waits_open_idx ON todo_waits (todo_id) WHERE settled_at IS NULL;

CREATE TABLE todo_attempts (
    todo_id uuid NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    attempt integer NOT NULL CHECK (attempt > 0),
    run_id text NOT NULL DEFAULT '',
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    outcome text NOT NULL DEFAULT '',
    evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
    PRIMARY KEY (todo_id, attempt)
);

-- A member's approval of one PR head (T-STK-04). credential_id names a row
-- of the credentials table T-ACC-04 adds.
CREATE TABLE todo_approvals (
    todo_id uuid NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    member_id bigint NOT NULL REFERENCES members(id),
    pr_head_sha text NOT NULL CHECK (pr_head_sha <> ''),
    credential_id text NOT NULL CHECK (credential_id <> ''),
    at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (todo_id, member_id, pr_head_sha)
);

-- Names and GitHub heads are item facts, recorded once (§8.1; owner ruling).
CREATE UNIQUE INDEX todos_branch_name_idx ON todos (repository_id, branch_name) WHERE branch_id IS NOT NULL;
CREATE UNIQUE INDEX todos_github_branch_idx ON todos (repository_id, github_branch) WHERE github_branch IS NOT NULL;

-- Stack-level attention (§4.1.2a): not a TODO state. Its writers are T-GH-05
-- (order) and T-GH-07 (force_push).
CREATE TABLE stack_attention (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    kind varchar(16) NOT NULL CHECK (kind IN ('order', 'force_push')),
    payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
    state varchar(8) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'settled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_by jsonb CHECK (settled_by IS NULL OR jsonb_typeof(settled_by) = 'object'),
    CHECK ((state = 'settled') = (settled_by IS NOT NULL))
);

CREATE INDEX stack_attention_open_idx ON stack_attention (repository_id) WHERE state = 'open';

-- The engine's work record links its TODO. A 'todo' item is a TODO made in
-- Smithers: no issue, its prompt in todo_revisions. paused_at is set by Stop
-- (T-STK-05) and overrides the item state in the projection.
ALTER TABLE mythical_items
    ADD COLUMN todo_id uuid UNIQUE REFERENCES todos(id) ON DELETE SET NULL,
    ADD COLUMN paused_at timestamptz,
    DROP CONSTRAINT mythical_items_source_check,
    ADD CONSTRAINT mythical_items_source_check CHECK (source IN ('issue', 'chat', 'todo'));

-- The issue number is a link, not an item's identity: only the issue door's
-- own items are one per issue.
DROP INDEX mythical_items_issue_idx;
CREATE UNIQUE INDEX mythical_items_issue_idx
    ON mythical_items (repository_id, issue_number)
    WHERE issue_number IS NOT NULL AND source = 'issue';

-- todo_branch_slug derives a branch slug from a TODO title (§8.1.1): ASCII
-- lowercase letters and digits joined by single hyphens, at most 48
-- characters, "todo" when nothing is left. It is the only implementation;
-- the backend calls it for every new TODO.
CREATE FUNCTION todo_branch_slug(title text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(NULLIF(btrim(left(btrim(regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g'), '-'), 48), '-'), ''), 'todo')
$$;

-- todo_branch_name answers the first free item branch name for a title in a
-- repository: smithers/<slug>, else smithers/<slug>-2, -3, ... with the slug
-- shortened so it stays within 48 characters. A name is taken when any
-- branch of the repository uses it as its name or as its GitHub branch.
CREATE FUNCTION todo_branch_name(repository bigint, title text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
    base text := todo_branch_slug(title);
    candidate text;
    k integer := 1;
BEGIN
    LOOP
        candidate := 'smithers/' || CASE WHEN k = 1 THEN base
            ELSE btrim(left(base, 48 - length(k::text) - 1), '-') || '-' || k END;
        IF NOT EXISTS (SELECT 1 FROM todos t WHERE t.repository_id = repository
                       AND (t.branch_name = candidate OR t.github_branch = candidate)) THEN
            RETURN candidate;
        END IF;
        k := k + 1;
    END LOOP;
END
$$;

-- Backfill: one TODO, one item branch, revision 1 and one imported event per
-- existing item that passed admission. A skipped item, and a cancelled issue
-- whose text was never approved, was never a TODO (M-16) and gets none. The
-- state follows §4.1.0; an item whose pull request is open is in review.
-- An item with a pull request (or a recorded proposal push) keeps its GitHub
-- branch as its name and github_branch, so no in-flight item opens a second
-- pull request. github_branch is the round-0 name; the engine still adds a
-- proposal round's -r<k> suffix. Every other item gets smithers/<slug>.
DO $$
DECLARE
    item record;
    todo_state text;
    branch uuid;
    branch_name text;
    title text;
BEGIN
    FOR item IN
        SELECT i.*,
               row_number() OVER (PARTITION BY i.repository_id ORDER BY i.created_at, i.id) AS todo_number,
               row_number() OVER (PARTITION BY i.repository_id
                                  ORDER BY (i.source = 'chat') DESC, i.issue_number NULLS LAST, i.created_at, i.id) AS position
          FROM mythical_items i
         WHERE i.state <> 'skipped'
           AND NOT (i.source = 'issue' AND i.state = 'cancelled' AND i.approved_digest = '')
         -- Items whose GitHub branch exists claim their names first.
         ORDER BY (i.pr_number IS NULL AND NOT COALESCE(i.pending_op ? 'branch', false)), i.created_at, i.id
    LOOP
        todo_state := CASE
            WHEN item.state = 'landed' THEN 'merged'
            WHEN item.state IN ('cancelled', 'rejected', 'declined') THEN 'dropped'
            WHEN item.state = 'blocked' THEN 'failed'
            WHEN item.state = 'proposed' THEN 'in_review'
            WHEN item.pr_number IS NOT NULL AND item.pr_state = 'open' AND item.state = 'queued' THEN 'in_review'
            WHEN item.state = 'queued' THEN 'queued'
            WHEN item.state IN ('running', 'retrying') AND
                 (item.checks->'firstStep'->>'generation')::bigint IS DISTINCT FROM item.generation THEN 'starting'
            ELSE 'working'
        END;
        title := COALESCE(NULLIF(left(btrim(split_part(item.issue_title, E'\n', 1)), 256), ''), 'Untitled TODO');
        IF item.pr_number IS NOT NULL OR COALESCE(item.pending_op ? 'branch', false) THEN
            -- An interrupted proposal already records its exact head
            -- branch. Otherwise reconstruct the branch the legacy engine
            -- used for this proposal round, including its round suffix.
            branch_name := NULLIF(item.pending_op ->> 'branch', '');
            IF branch_name IS NULL THEN
                branch_name := CASE WHEN item.issue_number IS NOT NULL THEN 'smithers/issue-' || item.issue_number
                                    ELSE 'smithers/change-' || left(replace(item.id::text, '-', ''), 12) END;
                IF item.proposal_round > 0 THEN
                    branch_name := branch_name || '-r' || item.proposal_round;
                END IF;
            END IF;
        ELSE
            branch_name := todo_branch_name(item.repository_id, title);
        END IF;
        branch := gen_random_uuid();
        INSERT INTO todos (id, repository_id, number, title, state, state_reason, issue_number, fixes_issue,
                           stack_position, branch_id, branch_name, github_branch, pr_number, created_by_actor, needs_you, failure, current_step,
                           merged_at, dropped_at, created_at, updated_at)
        VALUES (item.id, item.repository_id, item.todo_number, title, todo_state,
                CASE WHEN todo_state = 'dropped' THEN item.state ELSE '' END,
                CASE WHEN item.source = 'issue' THEN item.issue_number END, item.source = 'issue',
                lpad(item.position::text, 12, '0'), branch, branch_name, branch_name, item.pr_number, '{"system":"backfill"}', NULL,
                CASE WHEN todo_state = 'failed' THEN jsonb_build_object(
                    'step', 'run', 'class', COALESCE(item.checks -> 'fault' ->> 'class', 'factory'),
                    'message', item.reason, 'retryable', true) END,
                CASE WHEN todo_state = 'working' THEN item.state END,
                CASE WHEN todo_state = 'merged' THEN item.updated_at END,
                CASE WHEN todo_state = 'dropped' THEN item.updated_at END,
                item.created_at, item.updated_at);
        INSERT INTO todo_revisions (todo_id, rev, prompt, author_actor, reason, issue_digest, created_at)
        VALUES (item.id, 1, CASE WHEN item.source = 'issue' THEN item.issue_body ELSE item.summary END,
                '{"system":"backfill"}', CASE WHEN item.source = 'issue' THEN 'from-issue' ELSE 'create' END,
                CASE WHEN item.source = 'issue' THEN NULLIF(item.issue_digest, '') END, item.created_at);
        INSERT INTO todo_events (todo_id, seq, at, actor, kind, from_state, to_state, payload)
        VALUES (item.id, 1, item.updated_at, '{"system":"backfill"}', 'backfill', NULL, todo_state,
                jsonb_build_object('item_state', item.state));
        UPDATE mythical_items SET todo_id = item.id WHERE id = item.id;
    END LOOP;
END
$$;
