package db

import (
	"context"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// BackgroundRun is the Home row, not the legacy workflow API model.
type BackgroundRun struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

// ListFailedBackgroundRuns excludes TODO runs, dismissed failures and failures
// already retried. Native flow-load uses its generation as the immutable id.
func (q *Queries) ListFailedBackgroundRuns(ctx context.Context, repositoryID int64) ([]BackgroundRun, error) {
	rows, err := q.db.Query(ctx, `SELECT r.id::text, d.name, '' FROM workflow_runs r
 JOIN workflow_definitions d ON d.id = r.workflow_definition_id
 WHERE r.repository_id=$1 AND r.status='failure' AND r.dismissed_at IS NULL AND r.background_retry_id IS NULL
 AND r.execution_plane <> 'flow' AND r.trigger_event <> 'alert_remediation'
 UNION ALL
 SELECT 'flow-load:' || generation::text, 'flow-load', error FROM flow_loads
 WHERE repository_id=$1 AND state='idle' AND error<>'' AND attempt>=3
 AND dismissed_generation IS DISTINCT FROM generation AND retry_generation IS DISTINCT FROM generation
 ORDER BY 1`, repositoryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BackgroundRun{}
	for rows.Next() {
		var row BackgroundRun
		row.State = "failed"
		if err := rows.Scan(&row.ID, &row.Title, &row.Detail); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// LockBackgroundRetry serializes duplicate retry and dismiss against the failed
// source row. The caller holds this lock through creation and receipt storage.
func (q *Queries) LockBackgroundRetry(ctx context.Context, repositoryID, runID int64) (int64, bool, error) {
	var retry pgtype.Int8
	var status string
	var dismissed pgtype.Timestamptz
	err := q.db.QueryRow(ctx, `SELECT background_retry_id,status,dismissed_at FROM workflow_runs WHERE repository_id=$1 AND id=$2 FOR UPDATE`, repositoryID, runID).Scan(&retry, &status, &dismissed)
	return retry.Int64, status == "failure" && !dismissed.Valid, err
}
func (q *Queries) SaveBackgroundRetry(ctx context.Context, repositoryID, runID, retryID int64) error {
	_, err := q.db.Exec(ctx, `UPDATE workflow_runs SET background_retry_id=$3 WHERE repository_id=$1 AND id=$2`, repositoryID, runID, retryID)
	return err
}
func (q *Queries) DismissBackgroundRun(ctx context.Context, repositoryID, runID, userID int64) (bool, error) {
	tag, err := q.db.Exec(ctx, `UPDATE workflow_runs SET dismissed_by=COALESCE(dismissed_by,$3), dismissed_at=COALESCE(dismissed_at,NOW())
 WHERE repository_id=$1 AND id=$2 AND status='failure' AND background_retry_id IS NULL AND execution_plane <> 'flow' AND trigger_event <> 'alert_remediation'`, repositoryID, runID, userID)
	return tag.RowsAffected() == 1, err
}

// ControlFlowLoad changes only the generation named by Home. Retry resets the
// budget once; its existing worker admits the next generation. Replayed presses
// cannot reset another generation or erase its failure.
func (q *Queries) ControlFlowLoad(ctx context.Context, repositoryID, generation, userID int64, operation string) (bool, error) {
	var sql string
	if operation == "retry" {
		sql = `UPDATE flow_loads SET attempt=0, error='', loaded_commit='', next_attempt_at=NOW(), retry_generation=generation, version=version+1, updated_at=NOW()
 WHERE repository_id=$1 AND generation=$2 AND state='idle' AND error<>'' AND attempt>=3 AND dismissed_generation IS DISTINCT FROM generation AND retry_generation IS DISTINCT FROM generation`
	} else {
		sql = `UPDATE flow_loads SET dismissed_by=$3, dismissed_at=NOW(), dismissed_generation=generation, version=version+1, updated_at=NOW()
 WHERE repository_id=$1 AND generation=$2 AND state='idle' AND error<>'' AND attempt>=3 AND retry_generation IS DISTINCT FROM generation AND dismissed_generation IS DISTINCT FROM generation`
	}
	var tag interface{ RowsAffected() int64 }
	var err error
	if operation == "retry" {
		tag, err = q.db.Exec(ctx, sql, repositoryID, generation)
	} else {
		tag, err = q.db.Exec(ctx, sql, repositoryID, generation, userID)
	}
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 1 {
		return true, nil
	}
	// A durable receipt survives a newer generation, so a late retry remains an
	// acknowledgment of the original press, never a second launch.
	var receipt pgtype.Int8
	column := "retry_generation"
	if operation == "dismiss" {
		column = "dismissed_generation"
	}
	err = q.db.QueryRow(ctx, `SELECT `+column+` FROM flow_loads WHERE repository_id=$1`, repositoryID).Scan(&receipt)
	return receipt.Valid && strconv.FormatInt(receipt.Int64, 10) == strconv.FormatInt(generation, 10), err
}

// BackgroundRunStatus is a persisted completion fact used by the retry toast.
type BackgroundRunStatus struct {
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

func (q *Queries) BackgroundWorkflowStatus(ctx context.Context, repo, id int64) (BackgroundRunStatus, error) {
	var status string
	err := q.db.QueryRow(ctx, `SELECT child.status FROM workflow_runs original
 JOIN workflow_runs child ON child.id=COALESCE(original.background_retry_id,original.id)
 WHERE original.repository_id=$1 AND original.id=$2`, repo, id).Scan(&status)
	switch status {
	case "success":
		status = "succeeded"
	case "failure":
		status = "failed"
	}
	return BackgroundRunStatus{State: status}, err
}
func (q *Queries) BackgroundFlowLoadStatus(ctx context.Context, repo, generation int64) (BackgroundRunStatus, error) {
	var row BackgroundRunStatus
	var attempt int32
	var loaded, commit string
	var current int64
	var retry pgtype.Int8
	err := q.db.QueryRow(ctx, `SELECT state,error,attempt,loaded_commit,commit_id,generation,retry_generation FROM flow_loads WHERE repository_id=$1`, repo).Scan(&row.State, &row.Detail, &attempt, &loaded, &commit, &current, &retry)
	if err != nil {
		return row, err
	}
	if current != generation && (!retry.Valid || retry.Int64 != generation) {
		return BackgroundRunStatus{}, pgx.ErrNoRows
	}
	switch {
	case row.State == "running":
		row.State = "running"
	case attempt >= 3 && row.Detail != "":
		row.State = "failed"
	case loaded == commit && commit != "" && attempt == 0:
		row.State = "succeeded"
	default:
		row.State = "queued"
	}
	return row, nil
}
