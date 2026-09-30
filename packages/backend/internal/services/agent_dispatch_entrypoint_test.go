package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestDispatchAgentRun_RefusesByDefault(t *testing.T) {
	t.Parallel()
	// Production defaults refuse; this fixture guards that a zero-ID run writes nothing.
	d := &agentDispatch{svc: &AgentService{dispatchQ: &mockAgentDispatchQuerier{
		failWorkflowRunFn: func(_ context.Context, id int64) error {
			t.Fatalf("a dispatch without a persisted run must not fail run %d", id)
			return nil
		},
	}}, ctx: t.Context()}

	err := d.refuseRetiredAgentLoop()
	if err == nil {
		t.Fatal("expected the dispatch to refuse")
	}
	var apiErr *pkgerrors.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected a typed APIError, got %T", err)
	}
	if apiErr.Code != pkgerrors.CodeAgentLoopRetired {
		t.Fatalf("unexpected code: %q", apiErr.Code)
	}
	if apiErr.Status != http.StatusNotImplemented {
		t.Fatalf("unexpected status: %d", apiErr.Status)
	}
	if d.infraFailedMarked {
		t.Fatal("a dispatch with no persisted run cannot mark infrastructure failed")
	}
}

func TestDispatchAgentRun_RefusalMarksPersistedRunFailed(t *testing.T) {
	t.Parallel()
	const runID int64 = 42
	for _, tc := range []struct {
		name     string
		writeErr error
	}{
		{name: "failure persisted"},
		{name: "failure write refused", writeErr: errors.New("database unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var failedRunID int64
			d := &agentDispatch{
				svc: &AgentService{dispatchQ: &mockAgentDispatchQuerier{
					failWorkflowRunFn: func(_ context.Context, id int64) error {
						failedRunID = id
						return tc.writeErr
					},
				}},
				ctx: t.Context(),
				run: db.WorkflowRun{ID: runID},
			}
			err := d.refuseRetiredAgentLoop()
			var apiErr *pkgerrors.APIError
			if !errors.As(err, &apiErr) || apiErr.Code != pkgerrors.CodeAgentLoopRetired || apiErr.Status != http.StatusNotImplemented {
				t.Fatalf("expected a typed retired-loop refusal, got %v", err)
			}
			if !d.infraFailedMarked {
				t.Fatal("a persisted run must be marked infrastructure failed")
			}
			if failedRunID != runID {
				t.Fatalf("expected persisted run %d to fail, got %d", runID, failedRunID)
			}
		})
	}
}

func TestDispatchAgentRun_GuestEntrypointIsPerService(t *testing.T) {
	t.Parallel()
	// The flag lives on the service, so one test assuming an entrypoint
	// cannot change what another test's service does.
	assuming := &agentDispatch{svc: &AgentService{guestEntrypointAssumed: true}, ctx: t.Context()}
	if err := assuming.refuseRetiredAgentLoop(); err != nil {
		t.Fatalf("a service that assumes an entrypoint must pass the step: %v", err)
	}
	if assuming.infraFailedMarked {
		t.Fatal("passing the step must not mark the run failed")
	}

	refusing := &agentDispatch{svc: &AgentService{}, ctx: t.Context()}
	if err := refusing.refuseRetiredAgentLoop(); err == nil {
		t.Fatal("a second service must still refuse")
	}
}

// newTestDispatchService gives its fixtures a guest entrypoint; this proves
// that is the only reason those fixtures get past the refusal.
func TestDispatchAgentRun_TestFixtureAssumesAnEntrypoint(t *testing.T) {
	t.Parallel()
	if !newTestDispatchService(&mockAgentDispatchQuerier{}, nil).guestEntrypointAssumed {
		t.Fatal("the dispatch fixture must assume a guest entrypoint, or every pipeline test is testing the refusal")
	}
}
