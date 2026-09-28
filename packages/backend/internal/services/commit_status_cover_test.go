package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type commitStatusCovFailDispatcher struct{}

func (commitStatusCovFailDispatcher) DispatchEvent(context.Context, int64, webhooks.EventType, any) error {
	return errors.New("queue down")
}

func (commitStatusCovFailDispatcher) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	return nil
}

func TestCommitStatus_Cov_DispatchLoadsRepository(t *testing.T) {
	q := &mockCommitStatusQuerier{
		getRepoOwnerFn: func(context.Context, int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
			return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "acme", RepoName: "loaded-name"}, nil
		},
	}
	dispatcher := &mockCommitStatusDispatcher{}
	svc := NewCommitStatusService(q, WithCommitStatusWebhookDispatcher(dispatcher))

	status := sampleCommitStatus()
	if err := svc.dispatchCommitStatusEvent(context.Background(), status, &db.User{ID: 5, Username: "alice"}); err != nil {
		t.Fatalf("dispatchCommitStatusEvent returned error: %v", err)
	}
	if len(dispatcher.calls) != 1 || dispatcher.calls[0].repoID != status.RepositoryID || dispatcher.calls[0].eventType != webhooks.EventTypeStatus {
		t.Fatalf("dispatch calls = %+v", dispatcher.calls)
	}
	payload := dispatcher.calls[0].payload.(webhooks.CommitStatusEventPayload)
	if payload.Repository.Name != "loaded-name" || payload.Repository.FullName != "acme/loaded-name" || payload.Sender.Login != "alice" || payload.CommitStatus.ChangeID == "" || payload.CommitStatus.SHA == "" {
		t.Fatalf("payload = %+v", payload)
	}
}

func TestCommitStatus_Cov_ErrorBranches(t *testing.T) {
	t.Run("dispatch error maps internal", func(t *testing.T) {
		err := NewCommitStatusService(&mockCommitStatusQuerier{}, WithCommitStatusWebhookDispatcher(commitStatusCovFailDispatcher{})).
			dispatchCommitStatusEvent(context.Background(), sampleCommitStatus(), nil)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})

	t.Run("workflow validation internal", func(t *testing.T) {
		runID := int64(9)
		q := &mockCommitStatusQuerier{
			getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, errors.New("db down")
			},
		}
		_, err := NewCommitStatusService(q).CreateCommitStatus(context.Background(), 10, "sha", CreateCommitStatusInput{
			Context: "ci", Status: "success", WorkflowRunID: &runID,
		})
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})

	t.Run("update not found", func(t *testing.T) {
		q := &mockCommitStatusQuerier{
			updateByWorkflowRunFn: func(context.Context, db.UpdateLatestCommitStatusByWorkflowRunIDParams) (db.CommitStatus, error) {
				return db.CommitStatus{}, pgx.ErrNoRows
			},
		}
		_, err := NewCommitStatusService(q).UpdateCommitStatusForWorkflowRun(context.Background(), 5, "success", "done", "")
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusNotFound {
			t.Fatalf("err = %#v, want not found", err)
		}
	})
}
