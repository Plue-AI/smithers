package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestCommitStatus_Z_CreateValidationAndWorkflowRunErrors(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	for _, tc := range []struct {
		name  string
		input CreateCommitStatusInput
	}{
		{name: "unsafe context", input: CreateCommitStatusInput{Context: "ci\x00build", Status: "success"}},
		{name: "unsafe description", input: CreateCommitStatusInput{Context: "ci", Status: "success", Description: "bad\x00desc"}},
		{name: "unsafe target url", input: CreateCommitStatusInput{Context: "ci", Status: "success", TargetURL: "bad\x00url"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewCommitStatusService(&mockCommitStatusQuerier{}).CreateCommitStatus(ctx, 10, "sha", tc.input)
			assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
		})
	}

	runID := int64(44)
	svc := NewCommitStatusService(&mockCommitStatusQuerier{
		getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	})
	_, err := svc.CreateCommitStatus(ctx, 10, "sha", CreateCommitStatusInput{Context: "ci", Status: "success", WorkflowRunID: &runID})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	svc = NewCommitStatusService(&mockCommitStatusQuerier{
		getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("workflow lookup failed")
		},
	})
	_, err = svc.CreateCommitStatus(ctx, 10, "sha", CreateCommitStatusInput{Context: "ci", Status: "success", WorkflowRunID: &runID})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestCommitStatus_Z_UpdateAndResolveFallbackBranches(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	svc := NewCommitStatusService(&mockCommitStatusQuerier{})
	_, err := svc.UpdateCommitStatusForWorkflowRun(ctx, 0, "success", "ok", "")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = svc.UpdateCommitStatusForWorkflowRun(ctx, 1, "bogus", "ok", "")
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	svc = NewCommitStatusService(&mockCommitStatusQuerier{
		updateByWorkflowRunFn: func(context.Context, db.UpdateLatestCommitStatusByWorkflowRunIDParams) (db.CommitStatus, error) {
			return db.CommitStatus{}, errors.New("update failed")
		},
	})
	_, err = svc.UpdateCommitStatusForWorkflowRun(ctx, 1, "success", "ok", "")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}
