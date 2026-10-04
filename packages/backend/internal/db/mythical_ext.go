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
s.claim, s.running, s.lease_expires_at, s.next_attempt_at, s.attempts, s.pending_op, s.last_error, s.created_at, s.updated_at, s.factory_state, s.factory_error`

func scanMythicalStack(row interface{ Scan(...any) error }) (MythicalStack, error) {
	var s MythicalStack
	var pending []byte
	err := row.Scan(&s.RepositoryID, &s.ActorUserID, &s.State, &s.Reason, &s.ResetGeneration, &s.BootstrapDepth, &s.MaxParallel, &s.TipCommit,
		&s.TipChange, &s.NotesCommit, &s.LandedMain, &s.Generation, &s.RequestedGeneration, &s.ProcessedGeneration, &s.ClaimedGeneration,
		&s.Claim, &s.Running, &s.LeaseExpiresAt, &s.NextAttemptAt, &s.Attempts, &pending, &s.LastError, &s.CreatedAt, &s.UpdatedAt, &s.FactoryState, &s.FactoryError)
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
	FactoryState string
	FactoryError string
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
    factory_state = CASE WHEN $16 <> '' THEN $16 WHEN $8 <> '' AND $8 <> landed_main THEN '' ELSE factory_state END,
    factory_error = CASE WHEN $16 <> '' THEN $17 WHEN $8 <> '' AND $8 <> landed_main THEN '' ELSE factory_error END,
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
		arg.ClearPendingOp, arg.ResetGeneration, arg.Held, arg.FactoryState, arg.FactoryError).Scan(&generation)
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

// MythicalLandedPosition locates the main boundary on the stack.
func (q *Queries) MythicalLandedPosition(ctx context.Context, repositoryID int64, commitID string) (int32, error) {
	var position int32
	err := q.db.QueryRow(ctx, `SELECT position FROM mythical_changes WHERE repository_id = $1 AND commit_id = $2`,
		repositoryID, commitID).Scan(&position)
	return position, err
}

const mythicalItemColumns = `id, repository_id, issue_number, issue_title, issue_url, issue_digest, issue_body, approved_digest, proposal_round,
source, version, state, reason, attempt,
generation, lane, workspace_id, base_commit, candidate_base, candidate_head, candidate_verified, request_run_id, vibe_run_id, verify_run_id,
request_outcome, vibe_outcome, verify_outcome, summary, plan, integration, checks, pr_number, pr_url, pr_state, pr_head, pr_merge_commit,
pending_op, next_attempt_at, lane_started_at, created_at, updated_at, outsider, number, title, stack_position, paused_at, created_by, owner_id, flow_digest, revisions`

func scanMythicalItem(row interface{ Scan(...any) error }) (MythicalItem, error) {
	var i MythicalItem
	var plan, integration, checks, pending []byte
	err := row.Scan(&i.ID, &i.RepositoryID, &i.IssueNumber, &i.IssueTitle, &i.IssueURL, &i.IssueDigest, &i.IssueBody, &i.ApprovedDigest,
		&i.ProposalRound, &i.Source, &i.Version, &i.State,
		&i.Reason, &i.Attempt, &i.Generation, &i.Lane, &i.WorkspaceID, &i.BaseCommit, &i.CandidateBase, &i.CandidateHead, &i.CandidateVerified,
		&i.RequestRunID, &i.VibeRunID, &i.VerifyRunID, &i.RequestOutcome, &i.VibeOutcome, &i.VerifyOutcome, &i.Summary, &plan, &integration,
		&checks, &i.PRNumber, &i.PRURL, &i.PRState, &i.PRHead, &i.PRMergeCommit, &pending, &i.NextAttemptAt, &i.LaneStartedAt, &i.CreatedAt, &i.UpdatedAt, &i.Outsider, &i.Number, &i.Title, &i.StackPosition, &i.PausedAt, &i.CreatedBy, &i.OwnerID, &i.FlowDigest, &i.Revisions)
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
		ORDER BY (state IN ('skipped', 'declined', 'cancelled', 'landed', 'rejected', 'blocked')), stack_position NULLS LAST, created_at
		LIMIT $2`, repositoryID, limit)
	return scanMythicalItems(rows, err)
}

// ListMythicalItemsInStates returns every one of a repository's items in one
// of states, with no limit.
func (q *Queries) ListMythicalItemsInStates(ctx context.Context, repositoryID int64, states []string) ([]MythicalItem, error) {
	rows, err := q.db.Query(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items WHERE repository_id = $1 AND state = ANY($2)`,
		repositoryID, states)
	return scanMythicalItems(rows, err)
}

// ListMythicalPendingOperations includes dropped and old items beyond the
// display limit, so restart cannot lose an outbound reconciliation obligation.
func (q *Queries) ListMythicalPendingOperations(ctx context.Context, repositoryID int64) ([]MythicalItem, error) {
	rows, err := q.db.Query(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items
 WHERE repository_id = $1 AND pending_op IS NOT NULL ORDER BY created_at`, repositoryID)
	return scanMythicalItems(rows, err)
}

// ListMythicalPendingCompletions lists the landed items whose issue is
// still owed its completion evidence: one the stack saw land (a completion
// recorded) and not yet settled (closed, or never on main).
func (q *Queries) ListMythicalPendingCompletions(ctx context.Context, repositoryID int64) ([]MythicalItem, error) {
	rows, err := q.db.Query(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items WHERE repository_id = $1 AND state = 'landed'
		AND checks ? 'completion' AND COALESCE(checks->'completion'->>'outcome', '') = ''
		ORDER BY issue_number NULLS LAST, created_at`, repositoryID)
	return scanMythicalItems(rows, err)
}

func scanMythicalItems(rows pgx.Rows, err error) ([]MythicalItem, error) {
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

// LatestMythicalItemUpdate includes items outside the snapshot's display limit.
func (q *Queries) LatestMythicalItemUpdate(ctx context.Context, repositoryID int64) (pgtype.Timestamptz, error) {
	var updated pgtype.Timestamptz
	err := q.db.QueryRow(ctx, `SELECT MAX(updated_at) FROM mythical_items WHERE repository_id = $1`, repositoryID).Scan(&updated)
	return updated, err
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

// GetMythicalItemByIssue returns the active claim, or the newest historical
// item when the issue has no active claim. Historical UUID reads stay stable.
func (q *Queries) GetMythicalItemByIssue(ctx context.Context, repositoryID, issue int64) (MythicalItem, error) {
	return scanMythicalItem(q.db.QueryRow(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items
		WHERE repository_id = $1 AND issue_number = $2
		ORDER BY (state NOT IN ('landed', 'cancelled', 'rejected', 'declined')) DESC, created_at DESC, id DESC
		LIMIT 1`, repositoryID, issue))
}

// GetActiveMythicalItemByIssue excludes historical merged and dropped items.
func (q *Queries) GetActiveMythicalItemByIssue(ctx context.Context, repositoryID, issue int64) (MythicalItem, error) {
	return scanMythicalItem(q.db.QueryRow(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items
		WHERE repository_id = $1 AND issue_number = $2
		AND state NOT IN ('landed', 'cancelled', 'rejected', 'declined')`, repositoryID, issue))
}

// InsertMythicalItem creates an issue item; an existing active claim for the
// same issue is returned unchanged (inserted false). Settled history remains.
func (q *Queries) InsertMythicalItem(ctx context.Context, item MythicalItem) (MythicalItem, bool, error) {
	created, err := scanMythicalItem(q.db.QueryRow(ctx, `INSERT INTO mythical_items
		(repository_id, issue_number, issue_title, issue_url, issue_digest, issue_body, approved_digest, source, state, reason, outsider, checks)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'issue', $8, $9, $10, $11)
		ON CONFLICT (repository_id, issue_number) WHERE issue_number IS NOT NULL
		AND state NOT IN ('landed', 'cancelled', 'rejected', 'declined') DO NOTHING
		RETURNING `+mythicalItemColumns,
		item.RepositoryID, item.IssueNumber, item.IssueTitle, item.IssueURL, item.IssueDigest, item.IssueBody, item.ApprovedDigest,
		item.State, item.Reason, item.Outsider, jsonArg(item.Checks)))
	if err == nil {
		return created, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) || !item.IssueNumber.Valid {
		return MythicalItem{}, false, err
	}
	existing, err := q.GetActiveMythicalItemByIssue(ctx, item.RepositoryID, item.IssueNumber.Int64)
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

// MythicalRepositoryTokensSince is every metered model token (input,
// output and cache) the repository's work recorded since since, whether or
// not a workspace was named on it. A call whose usage the provider never
// reported (pending, or unknown) is charged at its reservation's bound, so it
// counts its bound_tokens; a failed call cannot have been charged.
func (q *Queries) MythicalRepositoryTokensSince(ctx context.Context, repositoryID int64, since time.Time) (int64, error) {
	var tokens int64
	err := q.db.QueryRow(ctx, `SELECT COALESCE(SUM(CASE WHEN outcome IN ('pending', 'unknown')
			THEN GREATEST(bound_tokens, input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)
			ELSE input_tokens + output_tokens + cache_read_tokens + cache_write_tokens END), 0)::bigint
		FROM model_usage WHERE repository_id = $1 AND created_at >= $2`, repositoryID, since).Scan(&tokens)
	return tokens, err
}

// MythicalItemCosts is the settled platform-key model cost, in USD nanos,
// each listed item recorded on its lane workspaces (mythical_lanes binds
// every one to its item). A call still pending has no price yet, and a call
// on a pooled subscription is never metered here; neither counts.
func (q *Queries) MythicalItemCosts(ctx context.Context, repositoryID int64, items []pgtype.UUID) (map[[16]byte]int64, error) {
	rows, err := q.db.Query(ctx, `SELECT l.item_id, COALESCE(SUM(u.cost_nanos), 0)::bigint
		FROM mythical_lanes l JOIN model_usage u ON u.workspace_id = l.workspace_id AND u.repository_id = l.repository_id
		WHERE l.repository_id = $1 AND l.item_id = ANY($2) GROUP BY l.item_id`, repositoryID, items)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	costs := map[[16]byte]int64{}
	for rows.Next() {
		var item pgtype.UUID
		var cost int64
		if err := rows.Scan(&item, &cost); err != nil {
			return nil, err
		}
		costs[item.Bytes] = cost
	}
	return costs, rows.Err()
}

// SaveMythicalItem writes every mutable field of item when its version is
// still item.Version, and answers the saved row (version + 1). A concurrent
// writer makes it answer pgx.ErrNoRows; the caller rereads and decides again.
// Outsider marks text from a non-maintainer approved by a maintainer's label.
// LaneStartedAt records when the current attempt's lane launched.
func (q *Queries) SaveMythicalItem(ctx context.Context, item MythicalItem) (MythicalItem, error) {
	return scanMythicalItem(q.db.QueryRow(ctx, `UPDATE mythical_items SET
		title = $38, paused_at = $39, owner_id = $40, flow_digest = $41, revisions = $42,
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
		jsonArg(item.PendingOp), item.NextAttemptAt, item.IssueBody, item.ApprovedDigest, item.ProposalRound, item.LaneStartedAt, item.Outsider, item.Title, item.PausedAt, item.OwnerID, item.FlowDigest, jsonArg(item.Revisions)))
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

// SaveMythicalItemUnderLease couples item CAS with the worker's live stack
// claim. It replaces unfenced persistence at the outbound send boundary.
func (q *Queries) SaveMythicalItemUnderLease(ctx context.Context, item MythicalItem, claim int64) (MythicalItem, error) {
	beginner, ok := q.db.(interface {
		Begin(context.Context) (pgx.Tx, error)
	})
	if !ok {
		return MythicalItem{}, errors.New("outbound persistence requires transactions")
	}
	tx, err := beginner.Begin(ctx)
	if err != nil {
		return MythicalItem{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	var repositoryID int64
	err = tx.QueryRow(ctx, `SELECT repository_id FROM mythical_stacks
 WHERE repository_id = $1 AND claim = $2 AND running AND lease_expires_at > NOW()
 FOR UPDATE`, item.RepositoryID, claim).Scan(&repositoryID)
	if err != nil {
		return MythicalItem{}, err
	}
	saved, err := New(tx).SaveMythicalItem(ctx, item)
	if err != nil {
		return MythicalItem{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MythicalItem{}, err
	}
	return saved, nil
}

// GetMythicalItemByNumber uses the repository TODO number, never an issue number.
func (q *Queries) GetMythicalItemByNumber(ctx context.Context, repositoryID, number int64) (MythicalItem, error) {
	return scanMythicalItem(q.db.QueryRow(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items WHERE repository_id=$1 AND number=$2`, repositoryID, number))
}

func (q *Queries) GetMythicalTodoRequest(ctx context.Context, repositoryID int64, session, request string) (MythicalItem, error) {
	return scanMythicalItem(q.db.QueryRow(ctx, `SELECT `+mythicalItemColumns+` FROM mythical_items WHERE repository_id=$1 AND checks->>'creation_session'=$2 AND checks->>'filedRequest'=$3`, repositoryID, session, request))
}
func (q *Queries) InsertMythicalTodo(ctx context.Context, repositoryID, userID int64, title, prompt string, revisions, checks json.RawMessage) (MythicalItem, error) {
	return scanMythicalItem(q.db.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,issue_body,created_by,owner_id,revisions,checks)
 VALUES($1,'todo','queued',$3,$3,$4,$2,$2,$5,$6) RETURNING `+mythicalItemColumns, repositoryID, userID, title, prompt, jsonArg(revisions), jsonArg(checks)))
}
