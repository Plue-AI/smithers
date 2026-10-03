-- TODOs, their revisions, events and item branch facts (spec §3, §4.1;
-- services/todo_service.go is the only writer).

-- name: LockTodoCreation :exec
-- Serializes a repository's TODO creation until commit, so its numbers stay
-- sequential with no gap and its append positions never collide.
SELECT pg_advisory_xact_lock(hashtextextended('smithers.todos.create:' || sqlc.arg(repository_id)::bigint::text, 0));

-- name: NextTodoNumber :one
SELECT (COALESCE(MAX(number), 0) + 1)::bigint AS number FROM todos WHERE repository_id = $1;

-- name: LastTodoStackPosition :one
SELECT COALESCE(MAX(stack_position), '')::text AS stack_position
FROM todos
WHERE repository_id = $1;

-- name: TodoBranchName :one
SELECT todo_branch_name(sqlc.arg(repository_id)::bigint, sqlc.arg(title)::text)::text AS name;

-- name: GetTodoByCreateKey :one
SELECT *
FROM todos
WHERE repository_id = sqlc.arg(repository_id)
  AND created_by_actor ->> 'person' = sqlc.arg(person)::text
  AND create_key = sqlc.arg(create_key)::text;

-- name: InsertTodo :one
INSERT INTO todos (
    id, repository_id, number, title, state, owner_id, issue_number, fixes_issue, stack_position, branch_id, branch_name, github_branch,
    created_by_actor, flow_name, create_key, create_digest
) VALUES (
    sqlc.arg(id), sqlc.arg(repository_id), sqlc.arg(number), sqlc.arg(title), sqlc.arg(state), sqlc.narg(owner_id),
    sqlc.narg(issue_number), sqlc.arg(fixes_issue), sqlc.arg(stack_position), sqlc.arg(branch_id), sqlc.arg(branch_name), sqlc.narg(github_branch),
    sqlc.arg(created_by_actor), sqlc.arg(flow_name), sqlc.narg(create_key), sqlc.narg(create_digest)
)
RETURNING *;

-- name: InsertTodoRevision :one
INSERT INTO todo_revisions (todo_id, rev, prompt, acceptance, author_actor, reason, issue_digest)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetTodo :one
SELECT * FROM todos WHERE id = $1;

-- name: GetTodoByNumber :one
SELECT * FROM todos WHERE repository_id = $1 AND number = $2;

-- name: UpdateTodo :one
-- The conditional write every TODO change goes through: it answers no row
-- when another writer changed the TODO since version was read.
UPDATE todos SET
    state = sqlc.arg(state)::varchar(16),
    state_reason = sqlc.arg(state_reason),
    merging = CASE WHEN sqlc.arg(state)::varchar(16) IN ('merged', 'dropped') THEN NULL ELSE merging END,
    pr_number = sqlc.narg(pr_number),
    needs_you = sqlc.narg(needs_you),
    failure = sqlc.narg(failure),
    queue = sqlc.narg(queue),
    current_step = sqlc.narg(current_step),
    lessons = sqlc.arg(lessons),
    merged_at = sqlc.narg(merged_at),
    dropped_at = sqlc.narg(dropped_at),
    version = version + 1,
    updated_at = NOW()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(version)
RETURNING *;

-- name: NextTodoEventSeq :one
SELECT (COALESCE(MAX(seq), 0) + 1)::bigint AS seq FROM todo_events WHERE todo_id = $1;

-- name: InsertTodoEvent :one
INSERT INTO todo_events (todo_id, seq, actor, kind, from_state, to_state, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: ListTodoEvents :many
SELECT * FROM todo_events WHERE todo_id = $1 ORDER BY seq;

-- name: ListTodoRevisions :many
SELECT * FROM todo_revisions WHERE todo_id = $1 ORDER BY rev;

-- name: ListTodos :many
-- A repository's TODOs in stack order, unmerged first-to-last, then the
-- merged and dropped ones.
SELECT sqlc.embed(t), t.branch_name,
       (SELECT count(*) FROM todo_revisions r WHERE r.todo_id = t.id)::bigint AS revisions,
       (SELECT COALESCE(max(e.seq), 0) FROM todo_events e WHERE e.todo_id = t.id)::bigint AS seq,
       (sum(CASE WHEN t.state NOT IN ('merged', 'dropped') THEN 1 ELSE 0 END)
          OVER (ORDER BY (t.state IN ('merged', 'dropped')), t.stack_position, t.number))::bigint AS place
FROM todos t
WHERE t.repository_id = $1
ORDER BY (t.state IN ('merged', 'dropped')), t.stack_position, t.number
LIMIT $2;

-- name: GetBranch :one
SELECT branch_id::text AS id, repository_id, branch_name AS name, 'item'::text AS kind, id AS todo_id, github_branch
FROM todos WHERE branch_id = sqlc.arg(id)::uuid;

-- name: UnmergedTodoPlace :one
-- A TODO's 1-based place among its repository's unmerged, undropped TODOs.
SELECT count(*)::bigint AS place
FROM todos t
WHERE t.repository_id = sqlc.arg(repository_id)
  AND t.state NOT IN ('merged', 'dropped')
  AND t.stack_position <= sqlc.arg(stack_position)::text COLLATE "C";

-- name: ListMythicalStackRepositories :many
-- The repositories that have a stack; the TODO routes default to the only one.
SELECT repository_id FROM mythical_stacks ORDER BY repository_id LIMIT 2;

-- name: ListTodoItemFacts :many
-- What the stack engine reads of its unsettled items' TODOs in one pass.
SELECT t.id, t.number, t.state, (t.needs_you IS NOT NULL AND t.needs_you <> 'null'::jsonb)::boolean AS needs_you_open
FROM todos t
WHERE t.repository_id = $1 AND t.state NOT IN ('merged', 'dropped');

-- name: ListTodoNumbers :many
SELECT id, number FROM todos WHERE repository_id = $1;

-- name: MemberOfUser :one
-- The member a signed-in user is, while they have access.
SELECT id FROM members WHERE user_id = $1 AND removed_at IS NULL AND suspended_at IS NULL;

-- name: SettleTodoWaits :exec
-- End every open wait with the TODO, leaving settled answers intact.
UPDATE todo_waits
SET settled_at = NOW(), settled_by = sqlc.arg(actor), outcome = sqlc.arg(outcome)::text
WHERE todo_id = sqlc.arg(todo_id) AND settled_at IS NULL;

-- name: InsertTodoRetryAttempt :exec
-- The TODO row is locked by projectItem; earlier attempts/evidence are immutable.
INSERT INTO todo_attempts (todo_id, attempt)
SELECT sqlc.arg(todo_id)::uuid, COALESCE(MAX(attempt), 0) + 1
FROM todo_attempts WHERE todo_id = sqlc.arg(todo_id)::uuid;
