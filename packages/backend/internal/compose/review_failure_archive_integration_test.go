package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

const reviewFailureCause = "smithers-review/ChangeSetUnreadable: NotFound: ProcessConfinement.confine: bwrap is not on PATH"

type failedReviewRuntime struct{ flowruntime.Runtime }

func (*failedReviewRuntime) Observe(_ context.Context, run, cursor string, _ int) (flowruntime.Observation, error) {
	sequence := int64(1)
	more := cursor == ""
	if !more {
		sequence = 2
	}
	raw, _ := json.Marshal(map[string]string{"cause": reviewFailureCause})
	return flowruntime.Observation{Terminal: true, HasMore: more, NextCursor: fmt.Sprint(sequence), Run: flowruntime.Run{RunID: run, FlowID: "review", Status: "failed", FailureMessage: reviewFailureCause}, Events: []flowruntime.Event{{RunID: run, Sequence: sequence, Kind: "control.run.failed", Payload: raw}}}, nil
}

type failedReviewResolver struct{ runtime flowruntime.Runtime }

func (r failedReviewResolver) ResolveExistingFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	return r.runtime, nil
}

type failedReviewArchiveHost struct{ fail bool }

func (h *failedReviewArchiveHost) CallRPC(_ context.Context, _ flowruntime.Target, _ string, payload json.RawMessage) (json.RawMessage, error) {
	if h.fail {
		return nil, fmt.Errorf("archive unavailable")
	}
	rows := []map[string]any{}
	if strings.Contains(string(payload), "run-summary") {
		rows = append(rows, map[string]any{"runId": "review-run", "flowId": "review", "status": "failed", "failureMessage": reviewFailureCause})
	}
	raw, err := json.Marshal(map[string]any{"ok": true, "payload": map[string]any{"rows": rows}})
	return raw, err
}
func (*failedReviewArchiveHost) Monitor(context.Context, flowruntime.Target, string, *int64) (json.RawMessage, error) {
	return json.RawMessage(`{"id":"review-run","state":"failed"}`), nil
}

func TestReviewFailureArchiveBeforeRetirement(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	host := &failedReviewArchiveHost{fail: true}
	machine := &reviewMachine{pool: pool, existing: failedReviewResolver{&failedReviewRuntime{}}, archive: &runArchive{pool: pool, host: host}}
	operation := uuid.NewString()
	admission := services.ReviewAdmission{RepositoryID: repo.ID, RequesterID: owner.ID}
	ref, _ := json.Marshal(struct{ Operation, Run string }{operation, "review-run"})
	_, err = machine.Observe(ctx, string(ref), admission)
	require.ErrorContains(t, err, "archive unavailable")
	host.fail = false
	result, err := machine.Observe(ctx, string(ref), admission)
	require.NoError(t, err)
	require.Equal(t, jobs.StateFailed, result.State)
	require.Equal(t, reviewFailureCause, result.Error)
	archive, err := readRunArchive(ctx, pool, repo.ID, reviewWorkspaceID(operation), "review-run")
	require.NoError(t, err)
	require.Contains(t, string(archive.Summary), reviewFailureCause)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM run_archive_events WHERE run_id='review-run'`).Scan(&count))
	require.Equal(t, 2, count, "every page retained exactly once after capture retry")
}
