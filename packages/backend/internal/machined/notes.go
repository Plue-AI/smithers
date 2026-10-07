package machined

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// CodingNoteRun is resolved from the pinned attempt, never from the most recent
// run on a host. The resolver locks the attempt in the burst transaction and
// returns nil for a branch without an active coding run. It must refuse until
// that run's daemon tools enforce stale reads and its durable notification
// consumer is composed. ParticipantID names the coding participant, not a user.
type CodingNoteRun struct {
	Branch        string
	ParticipantID string
	LineageID     string
	Scope         jobs.Scope
	Target        flowruntime.Target
	FlowID        string
	RunID         string
}

type CodingNoteRuns interface {
	ResolveCodingNoteRun(context.Context, pgx.Tx, string) (*CodingNoteRun, error)
}

type NoteSignaler interface {
	SignalInTx(context.Context, pgx.Tx, flowdispatch.SignalRequest) (jobs.RequestReceipt, error)
}

// OutsideChangeNotes consumes only BurstIngest's authenticated, verified facts.
// It adds no queue: admission and replay use the existing dispatcher intent.
// Keep BurstIngest.OutsideChanges unbound while the pinned host lacks the
// notification consumer or stale-write tool enforcement.
type OutsideChangeNotes struct {
	Runs       CodingNoteRuns
	Dispatcher NoteSignaler
}

func (s *OutsideChangeNotes) Admit(ctx context.Context, tx pgx.Tx, branch, burst string, actor json.RawMessage, files []string) error {
	if s == nil || s.Runs == nil || s.Dispatcher == nil || tx == nil {
		return ErrNotReady
	}
	var participant struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if json.Unmarshal(actor, &participant) != nil ||
		(participant.Kind != "person" && participant.Kind != "agent" && participant.Kind != "outside") ||
		(participant.Kind != "outside" && strings.TrimSpace(participant.ID) == "") || burst == "" || branch == "" || len(files) == 0 {
		return ErrUnauthorized
	}
	for _, file := range files {
		if !validBurstPath(file) {
			return ErrUnauthorized
		}
	}
	run, err := s.Runs.ResolveCodingNoteRun(ctx, tx, branch)
	if err != nil {
		return err
	}
	if run == nil {
		return nil
	}
	if run.Branch != branch || run.Target.WorkspaceID != branch || run.ParticipantID == "" || run.LineageID == "" || run.RunID == "" || run.FlowID != flowdispatch.TodoFlow ||
		run.Scope.TenantID == "" || run.Scope.PrincipalID == "" || run.Target.TenantID != run.Scope.TenantID || run.Target.PrincipalID != run.Scope.PrincipalID ||
		run.Target.BindingKind != flowdispatch.StackBindingKind || run.Target.BindingID == "" {
		return ErrUnauthorized
	}
	var repository int64
	if err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1`, branch).Scan(&repository); err != nil {
		return err
	}
	if run.Scope.TenantID != "repository:"+fmt.Sprint(repository) {
		return ErrUnauthorized
	}
	if participant.Kind == "agent" && participant.ID == run.ParticipantID {
		return nil
	}
	payload, err := json.Marshal(map[string]any{"kind": "outside_change", "id": burst, "actor": actor, "files": files, "targetLineageId": run.LineageID})
	if err != nil {
		return err
	}
	authority, err := json.Marshal(map[string]string{"source": "committed-watcher", "branch": branch, "burst": burst, "participant": run.ParticipantID})
	if err != nil {
		return err
	}
	_, err = s.Dispatcher.SignalInTx(ctx, tx, flowdispatch.SignalRequest{
		Scope: run.Scope, RequestID: "outside-change:" + branch + ":" + burst,
		Target: run.Target, FlowID: run.FlowID, RunID: run.RunID, Name: "outside_change", Payload: payload, AuthorizationContext: authority,
	})
	return err
}
