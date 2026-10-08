package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func checkpointAttempt(cp flowdispatch.RuntimeCheckpoint) int64 {
	var pin struct {
		Attempt int64 `json:"attempt"`
	}
	_ = json.Unmarshal(cp.Projection, &pin)
	if pin.Attempt > 0 {
		return pin.Attempt
	}
	return 1
}

// The archive is the native provider's retained monitor, not another phase
// projection. Its row lock fences model results against new native captures.
type monitorSummarySource struct{}

func (monitorSummarySource) ReadSummaryRun(ctx context.Context, tx pgx.Tx, id string, attempt int64) (services.SummaryRun, error) {
	workspace, run, qualified := strings.Cut(id, ":")
	if !qualified || workspace == "" || run == "" {
		return services.SummaryRun{}, pgx.ErrNoRows
	}
	result := services.SummaryRun{RunID: id, Attempt: attempt}
	var raw, checkpoint []byte
	err := tx.QueryRow(ctx, `SELECT a.repository_id,a.summary_revision,a.inspection_until,a.monitor,
 (SELECT d.external_receipt FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id
 WHERE r.operation=$3 AND r.tenant_id='repository:'||a.repository_id::text
 AND d.external_receipt->>'runId'=a.run_id AND d.external_receipt->'target'->>'WorkspaceID'=a.workspace_id
 ORDER BY r.created_at DESC LIMIT 1)
 FROM run_archives a WHERE a.workspace_id=$1 AND a.run_id=$2 AND a.summary_revision=a.summary_captured_revision FOR UPDATE OF a`, workspace, run, flowdispatch.OperationLaunch).Scan(&result.RepositoryID, &result.Revision, &result.InspectionUntil, &raw, &checkpoint)
	if err != nil {
		return services.SummaryRun{}, err
	}
	var cp flowdispatch.RuntimeCheckpoint
	if json.Unmarshal(checkpoint, &cp) != nil || cp.Target.TenantID != fmt.Sprintf("repository:%d", result.RepositoryID) || checkpointAttempt(cp) != attempt {
		return services.SummaryRun{}, pgx.ErrNoRows
	}
	owner, err := strconv.ParseInt(strings.TrimPrefix(cp.Target.PrincipalID, "user:"), 10, 64)
	if err != nil || owner <= 0 || !strings.HasPrefix(cp.Target.PrincipalID, "user:") {
		return services.SummaryRun{}, pgx.ErrNoRows
	}
	result.OwnerID = owner
	var value struct {
		Attempts []struct {
			Phases []struct {
				Title string
				Tone  string
				Cells []struct {
					Label  string
					Output string
					Code   string
					Quote  string
				}
			}
		}
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return services.SummaryRun{}, err
	}
	cellNumber := 0
	for _, a := range value.Attempts {
		for _, p := range a.Phases {
			phase := services.SummaryPhase{Number: len(result.Phases), Text: p.Title, Live: p.Tone == "live" || p.Tone == "wait", Cells: map[int]string{}}
			for _, c := range p.Cells {
				phase.Cells[cellNumber] = strings.Join([]string{c.Label, c.Output, c.Code, c.Quote}, "\n")
				cellNumber++
			}
			result.Phases = append(result.Phases, phase)
		}
	}
	return result, nil
}

// Only the authorized live subscription renews inspection. Listing, HTTP
// inspection and scrubbing remain reads and never admit summary work.
func (m *runMonitors) inspect(ctx context.Context, id string, cp flowdispatch.RuntimeCheckpoint) error {
	if m.summaries == nil {
		return nil
	}
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	_, err = tx.Exec(ctx, `UPDATE run_archives SET inspection_until=clock_timestamp()+interval '30 seconds'
 WHERE workspace_id=$1 AND run_id=$2 AND inspection_until<clock_timestamp()+interval '15 seconds'`, cp.Target.WorkspaceID, cp.RunID)
	if err != nil {
		return err
	}
	// A newly admitted run may not have its first archive yet. A subsequent
	// subscription page backfills it after the native observer captures it.
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM run_archives WHERE workspace_id=$1 AND run_id=$2)`, cp.Target.WorkspaceID, cp.RunID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		if err = m.summaries.AdmitRun(ctx, tx, id, checkpointAttempt(cp)); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (m *runMonitors) overlaySummaries(ctx context.Context, id string, attempt int64, value map[string]any) error {
	if m.summaries == nil {
		return nil
	}
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	values, err := m.summaries.ReadRunSummaries(ctx, tx, id, attempt)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	phaseNumber, cellNumber := 0, 0
	attempts, _ := value["attempts"].([]any)
	for _, a := range attempts {
		row, _ := a.(map[string]any)
		phases, _ := row["phases"].([]any)
		for _, p := range phases {
			phase, _ := p.(map[string]any)
			if text := values[fmt.Sprintf("phase:%d", phaseNumber)]; text != "" {
				phase["summary"] = text
			}
			phaseNumber++
			cells, _ := phase["cells"].([]any)
			for _, c := range cells {
				cell, _ := c.(map[string]any)
				if text := values[fmt.Sprintf("cell:%d", cellNumber)]; text != "" {
					cell["explain"] = text
				}
				cellNumber++
			}
		}
	}
	return nil
}
