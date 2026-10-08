package services

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A generated-page refresh is a background run on Home (§13.5, C-J8-06): the
// merge-refresh worker records each refresh as a workflow_runs record, so the
// shared Retry/Dismiss door (POST /api/runs/{id}) and dismissal apply to it.
// The worker stays the only refresher; the record is its Home projection.
const (
	mythicalWikiRunPath  = "flows/coding/wiki/flow.ts"
	mythicalWikiRunTitle = "Refresh wiki"
)

// openWikiRun returns the refresh's queued record: the one a Retry already
// queued, or a new one, holding input when given. Older open records were
// superseded by this refresh.
func openWikiRun(ctx context.Context, store db.DBTX, repositoryID int64, input json.RawMessage) (int64, error) {
	var queued int64
	var status string
	err := store.QueryRow(ctx, `SELECT r.id,r.status FROM workflow_runs r JOIN workflow_definitions d ON d.id=r.workflow_definition_id
 WHERE r.repository_id=$1 AND d.path=$2 AND r.execution_plane=$3 ORDER BY r.id DESC LIMIT 1`, repositoryID, mythicalWikiRunPath, WorkflowRunPlaneFlow).Scan(&queued, &status)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if status != "queued" {
		def, err := db.New(store).EnsureWorkflowDefinitionReference(ctx, db.EnsureWorkflowDefinitionReferenceParams{
			RepositoryID: repositoryID, Name: mythicalWikiRunTitle, Path: mythicalWikiRunPath, Config: json.RawMessage(`{}`)})
		if err != nil {
			return 0, err
		}
		if len(input) == 0 {
			input = json.RawMessage(`{}`)
		}
		run, err := db.New(store).CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{RepositoryID: repositoryID, WorkflowDefinitionID: def.ID,
			Status: "queued", TriggerEvent: "main", TriggerRef: MythicalBookmark, DispatchInputs: input, ExecutionPlane: WorkflowRunPlaneFlow})
		if err != nil {
			return 0, err
		}
		queued = run.ID
	} else if len(input) > 0 {
		if _, err = store.Exec(ctx, `UPDATE workflow_runs SET dispatch_inputs=$2,updated_at=NOW() WHERE id=$1`, queued, input); err != nil {
			return 0, err
		}
	}
	_, err = store.Exec(ctx, `UPDATE workflow_runs r SET status='cancelled',cancel_reason='superseded',completed_at=NOW(),updated_at=NOW()
 FROM workflow_definitions d WHERE d.id=r.workflow_definition_id AND r.repository_id=$1 AND d.path=$2 AND r.id<>$3 AND r.status IN ('queued','running')`,
		repositoryID, mythicalWikiRunPath, queued)
	return queued, err
}

// settleWikiRun moves the latest open refresh record: queued to running when
// its run starts, or to success, failure or cancelled when it settles.
func settleWikiRun(ctx context.Context, store db.DBTX, repositoryID int64, status string) error {
	from := []string{"queued", "running"}
	if status == "running" {
		from = []string{"queued"}
	}
	// The status trigger admits queued->running off the sandbox plane only for
	// the run the statement names (guard_workflow_run_status_claim).
	_, err := store.Exec(ctx, `WITH target AS MATERIALIZED (
 SELECT r.id FROM workflow_runs r JOIN workflow_definitions d ON d.id=r.workflow_definition_id
 WHERE r.repository_id=$1 AND d.path=$2 AND r.execution_plane=$5 ORDER BY r.id DESC LIMIT 1
), guard AS MATERIALIZED (SELECT set_config('smithers.workflow_run_status_id',id::text,true) FROM target)
UPDATE workflow_runs r SET status=$3::text,
 started_at=COALESCE(r.started_at,NOW()),
 completed_at=CASE WHEN $3::text IN ('success','failure','cancelled') THEN NOW() ELSE r.completed_at END,
 updated_at=NOW()
FROM target CROSS JOIN guard WHERE r.id=target.id AND r.status=ANY($4::text[])`,
		repositoryID, mythicalWikiRunPath, status, from, WorkflowRunPlaneFlow)
	return err
}

// retryWikiRun is the wiki's half of POST /api/runs/{id} {retry}: run is the
// failed refresh, locked by the caller. Only the latest refresh retries; it
// queues the next record and asks the worker for a refresh of main now. A
// repeated Retry answers the record already queued, so one refresh runs.
func (s *MythicalService) retryWikiRun(ctx context.Context, tx pgx.Tx, repositoryID, run int64) (int64, error) {
	var latest int64
	var status string
	err := tx.QueryRow(ctx, `SELECT r.id,r.status FROM workflow_runs r JOIN workflow_definitions d ON d.id=r.workflow_definition_id
 WHERE r.repository_id=$1 AND d.path=$2 AND r.execution_plane=$3 ORDER BY r.id DESC LIMIT 1 FOR UPDATE OF r`, repositoryID, mythicalWikiRunPath, WorkflowRunPlaneFlow).Scan(&latest, &status)
	if err != nil {
		return 0, err
	}
	if latest != run {
		if status == "queued" || status == "running" {
			return latest, nil
		}
		return 0, homeBackgroundError(409, "run_superseded", "conflict", "A later wiki refresh replaced this run")
	}
	row, err := db.New(tx).GetMythicalWiki(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && row.State == "off") {
		return 0, homeBackgroundError(409, "wiki_off", "conflict", "This repository declares no wiki")
	}
	if err != nil {
		return 0, err
	}
	var input json.RawMessage
	if err = tx.QueryRow(ctx, `SELECT COALESCE(dispatch_inputs,'{}') FROM workflow_runs WHERE id=$1`, run).Scan(&input); err != nil {
		return 0, err
	}
	next, err := openWikiRun(ctx, tx, repositoryID, input)
	if err != nil {
		return 0, err
	}
	if _, err = db.New(tx).RequestMythicalWiki(ctx, repositoryID); err != nil {
		return 0, err
	}
	return next, nil
}

// wikiRunDetail is the failed refresh's reason for its Home row.
func (s *MythicalService) wikiRunDetail(ctx context.Context, repositoryID int64) string {
	row, err := s.queries().GetMythicalWiki(ctx, repositoryID)
	if err != nil || row.State != "failed" {
		return ""
	}
	return row.Error
}
