package db

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const mythicalStackColumns = `s.repository_id, s.actor_user_id, s.state, s.reason, s.reset_generation, s.bootstrap_depth, s.max_parallel, s.tip_commit,
s.tip_change, s.notes_commit, s.landed_main, s.generation, s.requested_generation, s.processed_generation, s.claimed_generation,
s.claim, s.running, s.lease_expires_at, s.next_attempt_at, s.attempts, s.pending_op, s.last_error, s.created_at, s.updated_at`

func scanMythicalStack(row interface{ Scan(...any) error }) (MythicalStack, error) {
	var s MythicalStack
	var pending []byte
	err := row.Scan(&s.RepositoryID, &s.ActorUserID, &s.State, &s.Reason, &s.ResetGeneration, &s.BootstrapDepth, &s.MaxParallel, &s.TipCommit,
		&s.TipChange, &s.NotesCommit, &s.LandedMain, &s.Generation, &s.RequestedGeneration, &s.ProcessedGeneration, &s.ClaimedGeneration,
		&s.Claim, &s.Running, &s.LeaseExpiresAt, &s.NextAttemptAt, &s.Attempts, &pending, &s.LastError, &s.CreatedAt, &s.UpdatedAt)
	if len(pending) > 0 {
		s.PendingOp = json.RawMessage(pending)
	}
	return s, err
}

// Bootstrapping an absent stack creates its row. Bootstrapping an existing
// one is a no-op unless reset is set: then the worker rebuilds the stack from
// main and replaces whatever the bookmark holds (an operator's repair of a
// frozen stack).
const requestMythicalBootstrap = `
INSERT INTO mythical_stacks AS s (repository_id, actor_user_id, bootstrap_depth, reset_generation)
VALUES ($1, $2, $3, CASE WHEN $4 THEN 1 ELSE 0 END)
ON CONFLICT (repository_id) DO UPDATE
SET requested_generation = s.requested_generation + 1,
    actor_user_id = CASE WHEN $4 OR s.actor_user_id IS NULL THEN $2 ELSE s.actor_user_id END,
    bootstrap_depth = CASE WHEN $4 THEN $3 ELSE s.bootstrap_depth END,
    reset_generation = CASE WHEN $4 THEN s.requested_generation + 1 ELSE s.reset_generation END,
    state = CASE WHEN $4 THEN 'bootstrapping' ELSE s.state END,
    reason = CASE WHEN $4 THEN '' ELSE s.reason END,
    -- A new request is a new attempt: its watcher waits for this pass, not the last one's error.
    last_error = CASE WHEN $4 OR s.state = 'bootstrapping' THEN '' ELSE s.last_error END,
    next_attempt_at = NOW(),
    updated_at = NOW()
RETURNING ` + mythicalStackColumns

// RequestMythicalBootstrap records a request to create a repository's stack,
// or with reset to rebuild it from main (replacing whatever the bookmark
// holds, the operator's repair of a frozen stack).
func (q *Queries) RequestMythicalBootstrap(ctx context.Context, repositoryID, actorUserID int64, depth int32, reset bool) (MythicalStack, error) {
	return scanMythicalStack(q.db.QueryRow(ctx, requestMythicalBootstrap, repositoryID, actorUserID, depth, reset))
}

const getMythicalStack = `SELECT ` + mythicalStackColumns + ` FROM mythical_stacks s WHERE s.repository_id = $1`

// GetMythicalStack returns a repository's stack row.
func (q *Queries) GetMythicalStack(ctx context.Context, repositoryID int64) (MythicalStack, error) {
	return scanMythicalStack(q.db.QueryRow(ctx, getMythicalStack, repositoryID))
}

const requestMythicalStack = `
UPDATE mythical_stacks
SET requested_generation = requested_generation + 1,
    next_attempt_at = LEAST(next_attempt_at, NOW()),
    updated_at = NOW()
WHERE repository_id = $1
`

// RequestMythicalStack asks an existing stack's worker to run again (main
// moved, a lane submitted). It returns 0 when the repository has no stack.
func (q *Queries) RequestMythicalStack(ctx context.Context, repositoryID int64) (int64, error) {
	tag, err := q.db.Exec(ctx, requestMythicalStack, repositoryID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const requestStaleMythicalStacks = `
UPDATE mythical_stacks
SET requested_generation = requested_generation + 1,
    updated_at = NOW()
WHERE requested_generation = processed_generation
  AND state = 'active'
  AND updated_at < NOW() - make_interval(secs => $1)
`

// RequestStaleMythicalStacks re-requests active stacks not run recently, so a
// missed main-moved signal is still folded.
func (q *Queries) RequestStaleMythicalStacks(ctx context.Context, olderThanSeconds float64) (int64, error) {
	tag, err := q.db.Exec(ctx, requestStaleMythicalStacks, olderThanSeconds)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const claimMythicalStacks = `
WITH due AS (
	SELECT repository_id
	FROM mythical_stacks
	WHERE requested_generation > processed_generation
	  AND next_attempt_at <= NOW()
	  AND (NOT running OR lease_expires_at IS NULL OR lease_expires_at < NOW())
	ORDER BY next_attempt_at, repository_id
	FOR UPDATE SKIP LOCKED
	LIMIT $1
)
UPDATE mythical_stacks s
SET running = true,
    claim = s.claim + 1,
    claimed_generation = s.requested_generation,
    attempts = s.attempts + 1,
    lease_expires_at = NOW() + make_interval(secs => $2),
    updated_at = NOW()
FROM due
WHERE s.repository_id = due.repository_id
RETURNING ` + mythicalStackColumns

// ClaimMythicalStacks leases due stacks. A crashed worker's stack becomes due
// again when its lease expires.
func (q *Queries) ClaimMythicalStacks(ctx context.Context, limit int32, leaseSeconds float64) ([]MythicalStack, error) {
	rows, err := q.db.Query(ctx, claimMythicalStacks, limit, leaseSeconds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MythicalStack{}
	for rows.Next() {
		stack, err := scanMythicalStack(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, stack)
	}
	return out, rows.Err()
}

const setMythicalPendingOp = `
UPDATE mythical_stacks
SET pending_op = $3, updated_at = NOW()
WHERE repository_id = $1 AND claim = $2 AND running
`

// SetMythicalPendingOp persists (or, with nil, clears) the prepared ref
// update before it is pushed. It returns 0 when the claim was lost.
func (q *Queries) SetMythicalPendingOp(ctx context.Context, repositoryID, claim int64, op json.RawMessage) (int64, error) {
	var value any
	if len(op) > 0 {
		value = []byte(op)
	}
	tag, err := q.db.Exec(ctx, setMythicalPendingOp, repositoryID, claim, value)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// FinishMythicalStackParams closes one claim. Failed keeps the generation
// due after BackoffSeconds; every other outcome marks it processed. Empty
// ref fields keep their previous values. Changed bumps the event generation.
// A prepared write survives every finish except the one that confirmed it
// (ClearPendingOp), so a crash or a transient failure never loses evidence.
type FinishMythicalStackParams struct {
	RepositoryID int64
	Claim        int64
	State        string
	Reason       string
	TipCommit    string
	TipChange    string
	NotesCommit  string
	LandedMain   string
	Failed       bool
	// Held marks a Failed pass that met a held repository: it spends no
	// attempt.
	Held           bool
	Error          string
	BackoffSeconds float64
	Changed        bool
	ClearPendingOp bool
	// ResetGeneration is the reset this finish completed (0: none). Only that
	// generation is cleared; a newer reset stays requested.
	ResetGeneration int64
}

const finishMythicalStack = `
UPDATE mythical_stacks
SET processed_generation = CASE WHEN $9 THEN processed_generation ELSE GREATEST(processed_generation, claimed_generation) END,
    state = CASE WHEN $3 = '' THEN state ELSE $3 END,
    reason = $4,
    tip_commit = CASE WHEN $5 = '' THEN tip_commit ELSE $5 END,
    tip_change = CASE WHEN $6 = '' THEN tip_change ELSE $6 END,
    notes_commit = CASE WHEN $7 = '' THEN notes_commit ELSE $7 END,
    landed_main = CASE WHEN $8 = '' THEN landed_main ELSE $8 END,
    attempts = CASE WHEN $15 THEN GREATEST(attempts - 1, 0) WHEN $9 THEN attempts ELSE 0 END,
    next_attempt_at = CASE WHEN $9 THEN NOW() + make_interval(secs => $11) ELSE NOW() END,
    -- A pass claimed before a newer request does not answer it: its error waits for the next pass.
    last_error = CASE WHEN claimed_generation >= requested_generation OR $10 = '' THEN $10 ELSE last_error END,
    generation = generation + CASE WHEN $12 THEN 1 ELSE 0 END,
    pending_op = CASE WHEN $13 THEN NULL ELSE pending_op END,
    reset_generation = CASE WHEN $14 > 0 AND reset_generation = $14 THEN 0 ELSE reset_generation END,
    running = false,
    lease_expires_at = NULL,
    updated_at = NOW()
WHERE repository_id = $1 AND claim = $2 AND running
RETURNING generation
`

// FinishMythicalStack returns the stack's event generation, or pgx.ErrNoRows
// when the claim was lost to a newer claimant.
func (q *Queries) FinishMythicalStack(ctx context.Context, arg FinishMythicalStackParams) (int64, error) {
	var generation int64
	err := q.db.QueryRow(ctx, finishMythicalStack, arg.RepositoryID, arg.Claim, arg.State, strings.TrimSpace(arg.Reason), arg.TipCommit,
		arg.TipChange, arg.NotesCommit, arg.LandedMain, arg.Failed, strings.TrimSpace(arg.Error), arg.BackoffSeconds, arg.Changed,
		arg.ClearPendingOp, arg.ResetGeneration, arg.Held).Scan(&generation)
	return generation, err
}

// ReplaceMythicalChanges removes a stack's changes from position on and
// inserts rows (whose positions start there).
func (q *Queries) ReplaceMythicalChanges(ctx context.Context, repositoryID int64, from int32, rows []MythicalChange) error {
	if _, err := q.db.Exec(ctx, `DELETE FROM mythical_changes WHERE repository_id = $1 AND position >= $2`, repositoryID, from); err != nil {
		return err
	}
	for _, row := range rows {
		if _, err := q.db.Exec(ctx, `INSERT INTO mythical_changes
			(repository_id, position, change_id, commit_id, title, kind, item_id, issue_number, predecessor, folded_from)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			repositoryID, row.Position, row.ChangeID, row.CommitID, row.Title, row.Kind, row.ItemID, row.IssueNumber,
			row.Predecessor, row.FoldedFrom); err != nil {
			return err
		}
	}
	return nil
}

const mythicalChangeColumns = `repository_id, position, change_id, commit_id, title, kind, item_id, issue_number, predecessor, folded_from`

func scanMythicalChanges(rows pgx.Rows) ([]MythicalChange, error) {
	defer rows.Close()
	out := []MythicalChange{}
	for rows.Next() {
		var c MythicalChange
		if err := rows.Scan(&c.RepositoryID, &c.Position, &c.ChangeID, &c.CommitID, &c.Title, &c.Kind, &c.ItemID, &c.IssueNumber,
			&c.Predecessor, &c.FoldedFrom); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ListMythicalChanges returns a stack's changes, root first.
func (q *Queries) ListMythicalChanges(ctx context.Context, repositoryID int64) ([]MythicalChange, error) {
	rows, err := q.db.Query(ctx, `SELECT `+mythicalChangeColumns+` FROM mythical_changes WHERE repository_id = $1 ORDER BY position`, repositoryID)
	if err != nil {
		return nil, err
	}
	return scanMythicalChanges(rows)
}

// ListRecentMythicalChanges returns a stack's newest changes, tip first.
func (q *Queries) ListRecentMythicalChanges(ctx context.Context, repositoryID int64, limit int32) ([]MythicalChange, error) {
	rows, err := q.db.Query(ctx, `SELECT `+mythicalChangeColumns+` FROM mythical_changes WHERE repository_id = $1 ORDER BY position DESC LIMIT $2`,
		repositoryID, limit)
	if err != nil {
		return nil, err
	}
	return scanMythicalChanges(rows)
}

const mythicalItemColumns = `id, repository_id, issue_number, issue_title, issue_url, issue_digest, issue_body, approved_digest, proposal_round,
source, version, state, reason, attempt,
generation, lane, workspace_id, base_commit, candidate_base, candidate_head, candidate_verified, request_run_id, vibe_run_id, verify_run_id,
request_outcome, vibe_outcome, verify_outcome, summary, plan, integration, checks, pr_number, pr_url, pr_state, pr_head, pr_merge_commit,
pending_op, next_attempt_at, lane_started_at, created_at, updated_at, outsider`

func scanMythicalItem(row interface{ Scan(...any) error }) (MythicalItem, error) {
	var i MythicalItem
	var plan, integration, checks, pending []byte
	err := row.Scan(&i.ID, &i.RepositoryID, &i.IssueNumber, &i.IssueTitle, &i.IssueURL, &i.IssueDigest, &i.IssueBody, &i.ApprovedDigest,
		&i.ProposalRound, &i.Source, &i.Version, &i.State,
		&i.Reason, &i.Attempt, &i.Generation, &i.Lane, &i.WorkspaceID, &i.BaseCommit, &i.CandidateBase, &i.CandidateHead, &i.CandidateVerified,
		&i.RequestRunID, &i.VibeRunID, &i.VerifyRunID, &i.RequestOutcome, &i.VibeOutcome, &i.VerifyOutcome, &i.Summary, &plan, &integration,
		&checks, &i.PRNumber, &i.PRURL, &i.PRState, &i.PRHead, &i.PRMergeCommit, &pending, &i.NextAttemptAt, &i.LaneStartedAt, &i.CreatedAt, &i.UpdatedAt, &i.Outsider)
	i.Plan, i.Integration, i.Checks, i.PendingOp = rawJSON(plan), rawJSON(integration), rawJSON(checks), rawJSON(pending)
	return i, err
}

func rawJSON(value []byte) json.RawMessage {
	if len(value) == 0 {
		return nil
	}
	return json.RawMessage(value)
}

// ListMythicalItems returns a repository's items, oldest issue first, with
// settled ones after the ones still moving.
func (q *Queries) ListMythicalItems(ctx context.Context, repositoryID int64, limit int32) ([]MythicalItem, error) {
	rows, err := q.db.Query(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items WHERE repository_id = $1
		ORDER BY (state IN ('skipped', 'declined', 'cancelled', 'landed', 'rejected', 'blocked')), issue_number NULLS LAST, created_at
		LIMIT $2`, repositoryID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MythicalItem{}
	for rows.Next() {
		item, err := scanMythicalItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// NotifyMythical wakes the repository's `mythical` event stream with a hint.
func (q *Queries) NotifyMythical(ctx context.Context, repositoryID int64, payload string) error {
	_, err := q.db.Exec(ctx, `SELECT pg_notify($1, $2)`, "mythical_"+strconv.FormatInt(repositoryID, 10), payload)
	return err
}

// IsMythicalChange reports whether a change id is on the repository's stack.
func (q *Queries) IsMythicalChange(ctx context.Context, repositoryID int64, changeID string) (bool, error) {
	var owned bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mythical_changes WHERE repository_id = $1 AND change_id = $2)`,
		repositoryID, changeID).Scan(&owned)
	return owned, err
}

// GetMythicalItem returns one item.
func (q *Queries) GetMythicalItem(ctx context.Context, id pgtype.UUID) (MythicalItem, error) {
	return scanMythicalItem(q.db.QueryRow(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items WHERE id = $1`, id))
}

// GetMythicalItemByIssue returns a repository's item for one issue.
func (q *Queries) GetMythicalItemByIssue(ctx context.Context, repositoryID, issue int64) (MythicalItem, error) {
	return scanMythicalItem(q.db.QueryRow(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items
		WHERE repository_id = $1 AND issue_number = $2`, repositoryID, issue))
}

// InsertMythicalItem creates an issue item; an existing item for the same
// issue is returned unchanged (inserted false).
func (q *Queries) InsertMythicalItem(ctx context.Context, item MythicalItem) (MythicalItem, bool, error) {
	created, err := scanMythicalItem(q.db.QueryRow(ctx, `INSERT INTO mythical_items
		(repository_id, issue_number, issue_title, issue_url, issue_digest, issue_body, approved_digest, source, state, reason, outsider, checks)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'issue', $8, $9, $10, $11)
		ON CONFLICT (repository_id, issue_number) WHERE issue_number IS NOT NULL DO NOTHING
		RETURNING `+mythicalItemColumns,
		item.RepositoryID, item.IssueNumber, item.IssueTitle, item.IssueURL, item.IssueDigest, item.IssueBody, item.ApprovedDigest,
		item.State, item.Reason, item.Outsider, jsonArg(item.Checks)))
	if err == nil {
		return created, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) || !item.IssueNumber.Valid {
		return MythicalItem{}, false, err
	}
	existing, err := q.GetMythicalItemByIssue(ctx, item.RepositoryID, item.IssueNumber.Int64)
	return existing, false, err
}

// InsertMythicalChatItem records a complete chat submission once per
// candidate; a replay answers the existing item (inserted false).
func (q *Queries) InsertMythicalChatItem(ctx context.Context, item MythicalItem) (MythicalItem, bool, error) {
	created, err := scanMythicalItem(q.db.QueryRow(ctx, `INSERT INTO mythical_items
		(repository_id, issue_title, source, state, workspace_id, candidate_base, candidate_head, candidate_verified, request_run_id,
		 vibe_outcome, summary)
		VALUES ($1, $2, 'chat', 'integrating', $3, $4, $5, true, $6, 'submitted', $7)
		ON CONFLICT (repository_id, candidate_head) WHERE source = 'chat' DO NOTHING
		RETURNING `+mythicalItemColumns,
		item.RepositoryID, item.IssueTitle, item.WorkspaceID, item.CandidateBase, item.CandidateHead, item.RequestRunID, item.Summary))
	if err == nil {
		return created, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return MythicalItem{}, false, err
	}
	existing, err := scanMythicalItem(q.db.QueryRow(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items
		WHERE repository_id = $1 AND source = 'chat' AND candidate_head = $2`, item.RepositoryID, item.CandidateHead))
	return existing, false, err
}

// MythicalItemTokens is every metered model token (input, output and cache)
// the item's lane workspaces spent, across all its attempts.
func (q *Queries) MythicalItemTokens(ctx context.Context, itemID pgtype.UUID) (int64, error) {
	var tokens int64
	err := q.db.QueryRow(ctx, `SELECT COALESCE(SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens), 0)::bigint
		FROM mythical_lanes l JOIN model_usage u ON u.repository_id = l.repository_id AND u.workspace_id = l.workspace_id
		WHERE l.item_id = $1`, itemID).Scan(&tokens)
	return tokens, err
}

// SaveMythicalItem writes every mutable field of item when its version is
// still item.Version, and answers the saved row (version + 1). A concurrent
// writer makes it answer pgx.ErrNoRows; the caller rereads and decides again.
// Outsider marks text from a non-maintainer approved by a maintainer's label.
// LaneStartedAt records when the current attempt's lane launched.
func (q *Queries) SaveMythicalItem(ctx context.Context, item MythicalItem) (MythicalItem, error) {
	return scanMythicalItem(q.db.QueryRow(ctx, `UPDATE mythical_items SET
		issue_body = $33, approved_digest = $34, proposal_round = $35, lane_started_at = $36, outsider = $37,
		issue_title = $3, issue_url = $4, issue_digest = $5, state = $6, reason = $7, attempt = $8, generation = $9, lane = $10,
		workspace_id = $11, base_commit = $12, candidate_base = $13, candidate_head = $14, candidate_verified = $15,
		request_run_id = $16, vibe_run_id = $17, verify_run_id = $18, request_outcome = $19, vibe_outcome = $20, verify_outcome = $21,
		summary = $22, plan = $23, integration = $24, checks = $25, pr_number = $26, pr_url = $27, pr_state = $28, pr_head = $29,
		pr_merge_commit = $30, pending_op = $31, next_attempt_at = COALESCE($32, NOW()), version = version + 1, updated_at = NOW()
		WHERE id = $1 AND version = $2
		RETURNING `+mythicalItemColumns,
		item.ID, item.Version, item.IssueTitle, item.IssueURL, item.IssueDigest, item.State, item.Reason, item.Attempt, item.Generation,
		item.Lane, item.WorkspaceID, item.BaseCommit, item.CandidateBase, item.CandidateHead, item.CandidateVerified, item.RequestRunID,
		item.VibeRunID, item.VerifyRunID, item.RequestOutcome, item.VibeOutcome, item.VerifyOutcome, item.Summary, jsonArg(item.Plan),
		jsonArg(item.Integration), jsonArg(item.Checks), item.PRNumber, item.PRURL, item.PRState, item.PRHead, item.PRMergeCommit,
		jsonArg(item.PendingOp), item.NextAttemptAt, item.IssueBody, item.ApprovedDigest, item.ProposalRound, item.LaneStartedAt, item.Outsider))
}

func jsonArg(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	return []byte(value)
}

// SetMythicalMaxParallel sets a stack's lane count and wakes its worker.
func (q *Queries) SetMythicalMaxParallel(ctx context.Context, repositoryID int64, maxParallel int32) (int64, error) {
	tag, err := q.db.Exec(ctx, `UPDATE mythical_stacks SET max_parallel = $2, requested_generation = requested_generation + 1,
		generation = generation + 1, updated_at = NOW() WHERE repository_id = $1`, repositoryID, maxParallel)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const mythicalLaneColumns = `workspace_id, repository_id, item_id, name, created_at, retired_at`

func scanMythicalLane(row pgx.Row) (MythicalLane, error) {
	var l MythicalLane
	err := row.Scan(&l.WorkspaceID, &l.RepositoryID, &l.ItemID, &l.Name, &l.CreatedAt, &l.RetiredAt)
	return l, err
}

// GetMythicalLane returns the binding of one workspace, if the stack made it.
func (q *Queries) GetMythicalLane(ctx context.Context, workspaceID string) (MythicalLane, error) {
	return scanMythicalLane(q.db.QueryRow(ctx, `SELECT `+mythicalLaneColumns+` FROM mythical_lanes WHERE workspace_id = $1`, workspaceID))
}

// GetMythicalLaneByName returns an item's lane of one name.
func (q *Queries) GetMythicalLaneByName(ctx context.Context, itemID pgtype.UUID, name string) (MythicalLane, error) {
	return scanMythicalLane(q.db.QueryRow(ctx, `SELECT `+mythicalLaneColumns+` FROM mythical_lanes WHERE item_id = $1 AND name = $2`, itemID, name))
}

// BindMythicalLane records a provisioned workspace as an item's lane. When a
// concurrent claimant bound that name first it answers the existing binding
// and inserted false.
func (q *Queries) BindMythicalLane(ctx context.Context, lane MythicalLane) (MythicalLane, bool, error) {
	bound, err := scanMythicalLane(q.db.QueryRow(ctx, `INSERT INTO mythical_lanes (workspace_id, repository_id, item_id, name)
		VALUES ($1, $2, $3, $4) ON CONFLICT (item_id, name) DO NOTHING RETURNING `+mythicalLaneColumns,
		lane.WorkspaceID, lane.RepositoryID, lane.ItemID, lane.Name))
	if err == nil {
		return bound, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return MythicalLane{}, false, err
	}
	existing, err := q.GetMythicalLaneByName(ctx, lane.ItemID, lane.Name)
	return existing, false, err
}

// ListRetirableMythicalLanes returns a repository's unretired lanes that their
// item no longer references and that are older than the grace period.
func (q *Queries) ListRetirableMythicalLanes(ctx context.Context, repositoryID int64, grace time.Duration, limit int32) ([]MythicalLane, error) {
	rows, err := q.db.Query(ctx, `SELECT l.workspace_id, l.repository_id, l.item_id, l.name, l.created_at, l.retired_at
		FROM mythical_lanes l JOIN mythical_items i ON i.id = l.item_id
		WHERE l.repository_id = $1 AND l.retired_at IS NULL AND i.workspace_id <> l.workspace_id
		  AND l.created_at < NOW() - make_interval(secs => $2)
		ORDER BY l.created_at LIMIT $3`, repositoryID, grace.Seconds(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MythicalLane
	for rows.Next() {
		lane, err := scanMythicalLane(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, lane)
	}
	return out, rows.Err()
}

// RetireMythicalLane records that a lane's workspace was deleted.
func (q *Queries) RetireMythicalLane(ctx context.Context, workspaceID string) error {
	_, err := q.db.Exec(ctx, `UPDATE mythical_lanes SET retired_at = NOW() WHERE workspace_id = $1 AND retired_at IS NULL`, workspaceID)
	return err
}
