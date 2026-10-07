package machined

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// CodingNoteHost resolves the registered coding participant and notification
// lineage for this exact attempt. It must verify durable note delivery and
// daemon stale-write enforcement for the pinned runtime, using authenticated
// registration receipts. It performs no wake, network call or tool dispatch.
// A missing capability returns ErrNotReady; it never substitutes another run.
type CodingNoteHost interface {
	CodingNoteParticipant(context.Context, string, string, flowruntime.Pin) (participant, lineage string, err error)
}

// PinnedCodingNoteRuns reads the existing stack's current attempt under the
// caller's transaction. No shadow run table or most-recent-run lookup exists.
type PinnedCodingNoteRuns struct{ Host CodingNoteHost }

func (s *PinnedCodingNoteRuns) ResolveCodingNoteRun(ctx context.Context, tx pgx.Tx, branch string) (*CodingNoteRun, error) {
	if s == nil || s.Host == nil || tx == nil {
		return nil, ErrNotReady
	}
	rows, err := tx.Query(ctx, `SELECT id::text, repository_id, COALESCE(owner_id,0), request_run_id,
 COALESCE(flow_digest,''), COALESCE(checks->>'flowSource','')
 FROM mythical_items WHERE workspace_id=$1 AND state='running' AND request_run_id<>'' AND request_outcome=''
 FOR SHARE`, branch)
	if err != nil {
		return nil, err
	}
	var run *CodingNoteRun
	var pin flowruntime.Pin
	for rows.Next() {
		if run != nil {
			rows.Close()
			return nil, ErrUnauthorized
		}
		var id, runID, digest, source string
		var repository, owner int64
		if err = rows.Scan(&id, &repository, &owner, &runID, &digest, &source); err != nil {
			rows.Close()
			return nil, err
		}
		pin = flowruntime.Pin{Flow: flowdispatch.TodoFlow, SourceCommit: source, ExecutionDigest: digest}
		if !pin.Valid() || owner <= 0 {
			rows.Close()
			return nil, ErrNotReady
		}
		scope := jobs.Scope{TenantID: "repository:" + fmt.Sprint(repository), PrincipalID: "user:" + fmt.Sprint(owner)}
		run = &CodingNoteRun{Branch: branch, Scope: scope, FlowID: flowdispatch.TodoFlow, RunID: runID,
			Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: branch, BindingKind: flowdispatch.StackBindingKind, BindingID: id}}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if run == nil {
		return nil, nil
	}
	run.ParticipantID, run.LineageID, err = s.Host.CodingNoteParticipant(ctx, branch, run.RunID, pin)
	if err != nil {
		return nil, err
	}
	if run.ParticipantID == "" || run.LineageID == "" {
		return nil, ErrNotReady
	}
	return run, nil
}
