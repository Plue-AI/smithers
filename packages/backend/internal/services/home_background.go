package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

// HomeBackground shares the existing invocation, admission and machine provider.
// No browser-supplied flow, input, source or execution identity is accepted.
type HomeBackground struct {
	Pool    *pgxpool.Pool
	Invoker *InvokedFlowService
	Billing BillingPolicy
	Machine interface {
		Isolation() workspace.IsolationLevel
	}
	// wiki retries the merge-refresh worker's runs (SetHomeBackground).
	wiki *MythicalService
}

type HomeBackgroundReceipt struct {
	State string `json:"state"`
	RunID int64  `json:"run_id"`
	// wiki wakes the refresh worker once the Retry commits.
	wiki bool
}

func (s *HomeBackground) Control(ctx context.Context, repo, user, id int64, op, key string) (HomeBackgroundReceipt, error) {
	empty := HomeBackgroundReceipt{}
	if s == nil || s.Pool == nil {
		return empty, homeBackgroundError(503, "background_unavailable", "infra", "Background runs unavailable")
	}
	if op != "retry" && op != "dismiss" {
		return empty, homeBackgroundError(400, "invalid_run_action", "user", "Invalid run action")
	}
	if op == "retry" && (key == "" || strings.TrimSpace(key) != key || len(key) > 255) {
		return empty, homeBackgroundError(400, "invalid_run_action", "user", "Idempotency-Key required")
	}
	if op == "retry" {
		if s.Invoker == nil || s.Invoker.dispatcher == nil || s.Billing == nil || s.Machine == nil || s.Machine.Isolation() != workspace.IsolationSandboxed {
			return empty, homeBackgroundError(503, "background_retry_unavailable", "infra", "Isolated Retry unavailable")
		}
		var receipt HomeBackgroundReceipt
		err := s.Billing.AuthorizeWorkflowDispatchCommitted(ctx, repo, func(ctx context.Context, tx pgx.Tx) error {
			var err error
			receipt, err = s.controlTx(ctx, tx, repo, user, id, op, key)
			return err
		})
		if err == nil && receipt.wiki {
			s.wiki.MainMoved(context.WithoutCancel(ctx), repo)
		}
		return receipt, err
	}
	return s.controlTx(ctx, nil, repo, user, id, op, key)
}

func (s *HomeBackground) controlTx(ctx context.Context, tx pgx.Tx, repo, user, id int64, op, key string) (HomeBackgroundReceipt, error) {
	empty := HomeBackgroundReceipt{}
	own := tx == nil
	if own {
		var err error
		tx, err = s.Pool.Begin(ctx)
		if err != nil {
			return empty, err
		}
		defer tx.Rollback(context.Background())
	}
	commit := func() error {
		if own {
			return tx.Commit(ctx)
		}
		return nil
	}
	var err error
	var state string
	err = tx.QueryRow(ctx, `SELECT status FROM workflow_runs WHERE id=$1 AND repository_id=$2 AND execution_plane='flow' FOR UPDATE`, id, repo).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, homeBackgroundError(404, "run_not_found", "user", "Run unavailable")
	}
	if err != nil {
		return empty, err
	}
	if state != "failure" {
		return empty, homeBackgroundError(409, "run_not_failed", "conflict", "Run has not failed")
	}
	if op == "dismiss" {
		_, err = tx.Exec(ctx, `UPDATE workflow_runs SET dismissed_by=$3,dismissed_at=NOW() WHERE id=$1 AND repository_id=$2 AND dismissed_at IS NULL`, id, repo, user)
		if err == nil {
			err = commit()
		}
		return HomeBackgroundReceipt{State: "dismissed", RunID: id}, err
	}
	if s.Invoker == nil || s.Invoker.dispatcher == nil || s.Billing == nil || s.Machine == nil || s.Machine.Isolation() != workspace.IsolationSandboxed {
		return empty, homeBackgroundError(503, "background_retry_unavailable", "infra", "Isolated Retry unavailable")
	}
	// A generated-page refresh retries through its own worker, never the
	// invoked-flow path: the worker refreshes main on a wiki machine.
	var path string
	if err = tx.QueryRow(ctx, `SELECT d.path FROM workflow_runs r JOIN workflow_definitions d ON d.id=r.workflow_definition_id WHERE r.id=$1`, id).Scan(&path); err != nil {
		return empty, err
	}
	if path == mythicalWikiRunPath {
		if !s.wiki.wikiRefreshes() {
			return empty, homeBackgroundError(503, "background_retry_unavailable", "infra", "Isolated Retry unavailable")
		}
		next, err := s.wiki.retryWikiRun(ctx, tx, repo, id)
		if err == nil {
			err = commit()
		}
		if err != nil {
			return empty, err
		}
		return HomeBackgroundReceipt{State: "accepted", RunID: next, wiki: true}, nil
	}
	// The source row lock serializes keys and duplicate requests across members.
	var duplicate int64
	err = tx.QueryRow(ctx, `SELECT (payload->'projection'->>'workflowRunId')::bigint FROM product_job_requests
 WHERE tenant_id=$1 AND principal_id=$2 AND operation=$3 AND payload->'projection'->>'retryOf'=$4 AND payload->'projection'->>'retryKey'=$5`,
		fmt.Sprintf("repository:%d", repo), fmt.Sprintf("user:%d", user), flowdispatch.OperationLaunch, fmt.Sprint(id), key).Scan(&duplicate)
	if err == nil {
		return HomeBackgroundReceipt{State: "accepted", RunID: duplicate}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return empty, err
	}
	var flow, source, ref string
	var input, payload, checkpoint []byte
	err = tx.QueryRow(ctx, `SELECT i.flow_id,COALESCE(i.source_revision,''),r.trigger_ref,r.dispatch_inputs,j.payload,dispatch.external_receipt
 FROM workflow_runs r JOIN workflow_run_flow_invocations i ON i.workflow_run_id=r.id
 JOIN product_job_requests j ON j.id::text=i.operation_id JOIN product_job_dispatches dispatch ON dispatch.operation_id=j.id
 WHERE r.id=$1 AND r.repository_id=$2 AND r.execution_plane='flow' AND j.operation=$3`, id, repo, flowdispatch.OperationLaunch).Scan(&flow, &source, &ref, &input, &payload, &checkpoint)
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, homeBackgroundError(409, "run_pin_unavailable", "conflict", "Stored flow version unavailable")
	}
	if err != nil {
		return empty, err
	}
	pin, err := homeBackgroundPin(flow, source, payload, checkpoint, input)
	if err != nil {
		return empty, err
	}
	var run db.WorkflowRun
	run, _, err = s.Invoker.insertInvocation(ctx, tx, InvokedFlowLaunch{RepositoryID: repo, UserID: user, FlowID: flow, Input: input, TriggerRef: ref, Pin: pin, RetryOf: id, RetryKey: key}, pin.SourceCommit)
	if err == nil {
		err = commit()
	}
	if err != nil {
		return empty, err
	}
	return HomeBackgroundReceipt{State: "accepted", RunID: run.ID}, nil
}

// The stored admission pin survives a failure before a machine starts. An
// observed source or execution identity must agree, never replace that pin.
func homeBackgroundPin(flow, source string, payload, checkpoint, input []byte) (*flowruntime.Pin, error) {
	var stored struct {
		FlowID string           `json:"flowId"`
		Input  json.RawMessage  `json:"payload"`
		Pin    *flowruntime.Pin `json:"pin"`
	}
	var observed flowdispatch.RuntimeCheckpoint
	if json.Unmarshal(payload, &stored) != nil || (len(checkpoint) > 0 && json.Unmarshal(checkpoint, &observed) != nil) || stored.FlowID != flow {
		return nil, homeBackgroundError(409, "run_pin_unavailable", "conflict", "Stored flow version unavailable")
	}
	pin := stored.Pin
	if pin == nil {
		pin = &flowruntime.Pin{Flow: flow, SourceCommit: source, ExecutionDigest: observed.ExecutionDigest}
	}
	if !pin.Valid() || pin.Flow != flow || (source != "" && pin.SourceCommit != source) || (observed.ExecutionDigest != "" && observed.ExecutionDigest != pin.ExecutionDigest) {
		return nil, homeBackgroundError(409, "run_pin_unavailable", "conflict", "Stored flow version unavailable")
	}
	decodeInput := func(raw []byte) (any, error) {
		if !json.Valid(raw) {
			return nil, errors.New("invalid stored input")
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var value any
		err := decoder.Decode(&value)
		return value, err
	}
	original, originalErr := decodeInput(input)
	admitted, admittedErr := decodeInput(stored.Input)
	if originalErr != nil || admittedErr != nil {
		return nil, homeBackgroundError(409, "run_input_unavailable", "conflict", "Stored flow input unavailable")
	}
	originalBytes, _ := json.Marshal(original)
	admittedBytes, _ := json.Marshal(admitted)
	if string(originalBytes) != string(admittedBytes) {
		return nil, homeBackgroundError(409, "run_input_unavailable", "conflict", "Stored flow input unavailable")
	}
	return pin, nil
}

// BackgroundRuns reads retained workflow records; dismissal is shared, never deletion.
func (s *MythicalService) SetHomeBackground(provider *HomeBackground) {
	s.homeBackground = provider
	if provider != nil {
		provider.wiki = s
	}
}

// wikiRefreshes reports whether the merge-refresh worker can run a refresh.
func (s *MythicalService) wikiRefreshes() bool {
	return s != nil && s.launcher != nil && s.lanes != nil
}

func (s *MythicalService) BackgroundRuns(ctx context.Context, repository int64) ([]map[string]any, error) {
	wikiDetail := s.wikiRunDetail(ctx, repository)
	// A later generated-page refresh supersedes every earlier one.
	rows, err := s.store.Query(ctx, `SELECT r.id,d.name,d.path,r.status,COALESCE(i.flow_id,''),COALESCE(i.source_revision,''),r.dispatch_inputs,COALESCE(j.payload,'{}'),COALESCE(dispatch.external_receipt,'{}')
 FROM workflow_runs r JOIN workflow_definitions d ON d.id=r.workflow_definition_id
 LEFT JOIN workflow_run_flow_invocations i ON i.workflow_run_id=r.id
 LEFT JOIN product_job_requests j ON j.id::text=i.operation_id AND j.operation='flow.runtime.launch'
 LEFT JOIN product_job_dispatches dispatch ON dispatch.operation_id=j.id
 WHERE r.repository_id=$1 AND r.execution_plane='flow' AND r.dismissed_at IS NULL AND r.status IN ('queued','running','failure')
 AND (d.path<>$2 OR r.id=(SELECT max(l.id) FROM workflow_runs l WHERE l.repository_id=r.repository_id AND l.workflow_definition_id=r.workflow_definition_id))
 ORDER BY r.created_at,r.id`, repository, mythicalWikiRunPath)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id int64
		var title, path, state, flow, source string
		var input, payload, checkpoint []byte
		if err := rows.Scan(&id, &title, &path, &state, &flow, &source, &input, &payload, &checkpoint); err != nil {
			return nil, err
		}
		actions := []any{}
		run := map[string]any{"id": fmt.Sprint(id), "title": title, "state": state, "actions": actions}
		if state == "failure" {
			run["state"] = "failed"
			provider := s.homeBackground
			wiki := path == mythicalWikiRunPath
			retryable := wiki && s.wikiRefreshes()
			if !wiki {
				_, pinErr := homeBackgroundPin(flow, source, payload, checkpoint, input)
				retryable = pinErr == nil
			}
			if retryable && provider != nil && provider.Invoker != nil && provider.Invoker.dispatcher != nil && provider.Billing != nil && provider.Machine != nil && provider.Machine.Isolation() == workspace.IsolationSandboxed {
				actions = append(actions, map[string]any{"tag": "background.retry", "label": "Retry"})
			}
			if provider != nil && provider.Pool != nil {
				actions = append(actions, map[string]any{"tag": "background.dismiss", "label": "Dismiss"})
			}
			run["actions"] = actions
			if wiki && wikiDetail != "" {
				run["detail"] = wikiDetail
			}
		}
		result = append(result, run)
	}
	return result, rows.Err()
}

func (s *HomeBackground) Status(ctx context.Context, repo, id int64) (HomeBackgroundReceipt, error) {
	if s == nil || s.Pool == nil {
		return HomeBackgroundReceipt{}, homeBackgroundError(503, "background_unavailable", "infra", "Background runs unavailable")
	}
	var state string
	err := s.Pool.QueryRow(ctx, `SELECT status FROM workflow_runs WHERE repository_id=$1 AND id=$2 AND execution_plane='flow'`, repo, id).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return HomeBackgroundReceipt{}, homeBackgroundError(404, "run_not_found", "user", "Run unavailable")
	}
	return HomeBackgroundReceipt{State: state, RunID: id}, err
}

func homeBackgroundError(status int, code, class, message string) error {
	return &TodoControlError{Status: status, Code: code, Class: class, Message: message}
}
