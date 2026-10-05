package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type BackgroundRunReceipt struct {
	State   string `json:"state"`
	ID      string `json:"id"`
	RetryID string `json:"retry_id,omitempty"`
}
type BackgroundRerunner interface {
	RerunRun(context.Context, RerunInput) (*WorkflowRunResult, error)
}

// BackgroundRunService reuses legacy rerun for sandbox workflows and native
// flow-load's own durable worker for Flow runs, which legacy rerun refuses.
type BackgroundRunService struct {
	Queries  *db.Queries
	Runner   BackgroundRerunner
	Mythical *MythicalService
}

func backgroundRef(id string) (int64, bool, error) {
	value, native := strings.CutPrefix(id, "flow-load:")
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n <= 0 || strconv.FormatInt(n, 10) != value {
		return 0, false, &TodoControlError{Status: 400, Code: "invalid_run", Class: "user", Message: "Invalid run"}
	}
	return n, native, nil
}
func (s *BackgroundRunService) List(ctx context.Context, repo int64) ([]db.BackgroundRun, error) {
	return s.Queries.ListFailedBackgroundRuns(ctx, repo)
}
func (s *BackgroundRunService) Control(ctx context.Context, repo, user int64, id, op string) (BackgroundRunReceipt, error) {
	fail := func(status int, code, message string) (BackgroundRunReceipt, error) {
		return BackgroundRunReceipt{}, &TodoControlError{Status: status, Code: code, Class: "user", Message: message}
	}
	if op != "retry" && op != "dismiss" {
		return fail(400, "invalid_run_action", "Invalid run action")
	}
	n, native, err := backgroundRef(id)
	if err != nil {
		return BackgroundRunReceipt{}, err
	}
	receipt := BackgroundRunReceipt{State: "accepted", ID: id}
	if native {
		if op == "retry" && (s.Mythical == nil || !s.Mythical.flowLoad) {
			return fail(503, "runs_unavailable", "Run retry unavailable")
		}
		changed, err := s.Queries.ControlFlowLoad(ctx, repo, n, user, op)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "run_not_found", "Run not found")
		}
		if err != nil {
			return receipt, err
		}
		if !changed {
			return fail(409, "stale_run", "Run is no longer a failed background run")
		}
		if op == "retry" {
			s.Mythical.MainMoved(context.WithoutCancel(ctx), repo)
		}
		return receipt, nil
	}
	if op == "dismiss" {
		ok, err := s.Queries.DismissBackgroundRun(ctx, repo, n, user)
		if err != nil {
			return receipt, err
		}
		if !ok {
			return fail(409, "stale_run", "Run is no longer a failed background run")
		}
		return receipt, nil
	}
	if s.Runner == nil {
		return fail(503, "runs_unavailable", "Run retry unavailable")
	}
	result, err := s.Runner.RerunRun(ctx, RerunInput{RepositoryID: repo, UserID: user, RunID: n, Background: true})
	if err != nil {
		return receipt, err
	}
	receipt.RetryID = strconv.FormatInt(result.WorkflowRunID, 10)
	return receipt, nil
}

func (s *BackgroundRunService) Status(ctx context.Context, repo int64, id string) (db.BackgroundRunStatus, error) {
	n, native, err := backgroundRef(id)
	if err != nil {
		return db.BackgroundRunStatus{}, err
	}
	if native {
		return s.Queries.BackgroundFlowLoadStatus(ctx, repo, n)
	}
	return s.Queries.BackgroundWorkflowStatus(ctx, repo, n)
}
