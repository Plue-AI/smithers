package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// LearningBackgroundRuns reads the dispatcher's durable state. Completed and
// cancelled work leaves Home; no source read or projection wakes a machine.
func (s *MythicalService) LearningBackgroundRuns(ctx context.Context, repository int64) ([]map[string]any, error) {
	rows, err := s.store.Query(ctx, learningBackgroundQuery+` WHERE state NOT IN ('completed','cancelled') AND COALESCE(terminal_receipt->>'homeDismissed','false')<>'true' ORDER BY id`, repository, fmt.Sprintf("repository:%d", repository))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []map[string]any{}
	for rows.Next() {
		var id, state string
		var todo int64
		var terminal, payload []byte
		var operation string
		if err := rows.Scan(&id, &state, &todo, &terminal, &operation, &payload); err != nil {
			return nil, err
		}
		storedState := state
		switch state {
		case "accepted", "dispatching":
			state = "queued"
		case "uncertain":
			state = "failed"
		case "running", "waiting", "failed":
		default:
			return nil, fmt.Errorf("unknown Learning dispatch state %q", state)
		}
		actions := []any{}
		if state == "failed" && s.homeBackground != nil && s.homeBackground.Pool != nil {
			if storedState == "failed" && s.learningMachines != nil && s.launcher != nil && s.homeBackground.Billing != nil && learningHomeRetryPinAvailable(operation, payload) {
				actions = append(actions, map[string]any{"tag": "background.retry", "label": "Retry"})
			}
			actions = append(actions, map[string]any{"tag": "background.dismiss", "label": "Dismiss"})
		}
		runs = append(runs, map[string]any{"id": id, "title": fmt.Sprintf("Learning · T%d", todo), "state": state, "actions": actions})
	}
	return runs, rows.Err()
}

const learningBackgroundQuery = `SELECT * FROM (SELECT r.id,r.state,i.number,r.terminal_receipt,r.operation,r.payload FROM product_job_requests r
 JOIN mythical_items i ON i.id::text=r.payload->'target'->>'BindingID' AND i.repository_id=$1
 WHERE r.tenant_id=$2 AND r.operation='flow.runtime.launch'
 AND i.source='todo' AND i.state='landed' AND i.pr_state='merged'
 AND r.payload->'target'->>'TenantID'=r.tenant_id
 AND r.payload->'target'->>'PrincipalID'=r.principal_id AND r.principal_id='user:' || i.owner_id::text
 AND r.payload->'payload'->>'todo'=i.number::text
 AND r.payload->>'flowId'='learning' AND r.payload->'target'->>'BindingKind'='learning'

 UNION ALL
 SELECT r.id,r.state,i.number,r.terminal_receipt,r.operation,r.payload FROM product_job_requests r
 JOIN mythical_items i ON i.id::text=r.payload->>'item' AND i.repository_id=$1
 WHERE r.tenant_id=$2 AND r.operation='learning.admission'
 AND i.source='todo' AND i.state='landed' AND i.pr_state='merged'
 AND r.payload->>'repository'=i.repository_id::text
 AND r.payload->>'todo'=i.number::text AND r.payload->>'commit'=i.pr_merge_commit
 AND r.principal_id='user:' || i.owner_id::text
) learning`

// ControlLearning uses the same qualified source as Home, with the persisted
// owner scope rather than changing a merged TODO's Learning identity.
func (s *HomeBackground) ControlLearning(ctx context.Context, repo, user int64, id, op, key string) (map[string]any, error) {
	if s == nil || s.Pool == nil || s.wiki == nil {
		return nil, homeBackgroundError(503, "background_unavailable", "infra", "Background runs unavailable")
	}
	if op != "retry" && op != "dismiss" || op == "retry" && (key == "" || strings.TrimSpace(key) != key || len(key) > 255) {
		return nil, homeBackgroundError(400, "invalid_run_action", "user", "Invalid run action")
	}
	var apply func(context.Context, pgx.Tx) error
	apply = func(ctx context.Context, tx pgx.Tx) error {
		if tx == nil {
			return pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error { return apply(ctx, tx) })
		}
		var found string
		if err := tx.QueryRow(ctx, learningBackgroundQuery+` WHERE id::text=$3`, repo, fmt.Sprintf("repository:%d", repo), id).Scan(&found, new(string), new(int64), new([]byte), new(string), new([]byte)); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return homeBackgroundError(404, "run_not_found", "user", "Run unavailable")
			}
			return err
		}
		store, err := jobs.NewStore(s.Pool)
		if err != nil {
			return err
		}
		var principal, operation string
		var checkpoint json.RawMessage
		if err := tx.QueryRow(ctx, `SELECT r.principal_id,r.operation,d.external_receipt FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE r.id=$1`, id).Scan(&principal, &operation, &checkpoint); err != nil {
			return err
		}
		if op == "retry" {
			if s.wiki.learningMachines == nil || s.wiki.launcher == nil {
				return homeBackgroundError(503, "background_retry_unavailable", "infra", "Isolated Retry unavailable")
			}
			if operation != LearningAdmissionOperation {
				var payload []byte
				if err := tx.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE id=$1`, id).Scan(&payload); err != nil {
					return err
				}
				if !learningHomeRetryPinAvailable(operation, payload) {
					return homeBackgroundError(409, "run_pin_unavailable", "conflict", "Stored flow version unavailable")
				}
				checkpoint = nil
			}
		}
		err = store.ControlFailedInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: principal}, id, op, key, checkpoint)
		if errors.Is(err, jobs.ErrUncertainResolution) {
			return homeBackgroundError(409, "run_not_failed", "conflict", "Run has not failed")
		}
		return err
	}
	var err error
	if op == "retry" {
		if s.Billing == nil {
			return nil, homeBackgroundError(503, "background_retry_unavailable", "infra", "Isolated Retry unavailable")
		}
		err = s.Billing.AuthorizeWorkflowDispatchCommitted(ctx, repo, apply)
	} else {
		err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error { return apply(ctx, tx) })
	}
	if err != nil {
		return nil, err
	}
	state := "accepted"
	if op == "dismiss" {
		state = "dismissed"
	}
	return map[string]any{"state": state, "run_id": id}, nil
}

func (s *HomeBackground) LearningStatus(ctx context.Context, repo int64, id string) (map[string]any, error) {
	if s == nil || s.Pool == nil {
		return nil, homeBackgroundError(503, "background_unavailable", "infra", "Background runs unavailable")
	}
	var found, state string
	var number int64
	var terminal []byte
	err := s.Pool.QueryRow(ctx, learningBackgroundQuery+` WHERE id::text=$3`, repo, fmt.Sprintf("repository:%d", repo), id).Scan(&found, &state, &number, &terminal, new(string), new([]byte))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, homeBackgroundError(404, "run_not_found", "user", "Run unavailable")
	}
	if state == "completed" {
		var operation string
		var item string
		if err := s.Pool.QueryRow(ctx, `SELECT operation,COALESCE(payload->>'item','') FROM product_job_requests WHERE id=$1`, id).Scan(&operation, &item); err != nil {
			return nil, err
		}
		if operation == LearningAdmissionOperation {
			if err := s.Pool.QueryRow(ctx, `SELECT state FROM product_job_requests WHERE operation='flow.runtime.launch' AND tenant_id=$1 AND request_id=$2`, fmt.Sprintf("repository:%d", repo), "learning-run:"+item).Scan(&state); err != nil {
				return nil, err
			}
		}
	}
	switch state {
	case "completed":
		state = "success"
	case "failed", "uncertain":
		state = "failure"
	case "accepted", "dispatching", "waiting":
		state = "queued"
	}
	return map[string]any{"state": state, "run_id": id}, err
}

// Admission may resolve its first pin in the worker. A launch must retain the
// original immutable Learning pin before Home can offer or authorize Retry.
func learningHomeRetryPinAvailable(operation string, payload []byte) bool {
	if operation == LearningAdmissionOperation {
		return true
	}
	var saved struct {
		Pin *flowruntime.Pin `json:"pin"`
	}
	return json.Unmarshal(payload, &saved) == nil && saved.Pin != nil && saved.Pin.Valid() && saved.Pin.Flow == "learning"
}
