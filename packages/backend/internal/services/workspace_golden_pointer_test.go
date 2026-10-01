package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// controllerGenericNotFound is the EXACT envelope the deployed microsandbox
// controller returns when a create references a snapshot id that is not in
// sandbox_snapshots: writeStoreError maps store.ErrNotFound to this generic
// code and prose, with no mention of the word "snapshot" anywhere.
//
// The previous detector substring-matched "snapshot" against
// ErrorCode+" "+Message, so this envelope never matched, MarkBad never fired,
// and golden pointer 34789ae5-f88d-4d2b-a690-9970fbf979c1 sat `ready` while
// dangling at sh-xuixtwzc6swvpu0qjn6q from 2026-07-18 — every workspace create
// paying a wasted snapshot boot plus VM delete. These tests fail against that
// implementation and are the regression gate for it.
func controllerGenericNotFound() *sandbox.StatusError {
	return &sandbox.StatusError{
		StatusCode: 404,
		ErrorCode:  "not_found",
		Code:       "not_found",
		Message:    "sandbox resource was not found",
	}
}

func TestGoldenSnapshotDetection_GenericControllerNotFoundIsSnapshotSpecific(t *testing.T) {
	t.Parallel()

	assert.True(t,
		goldenSnapshotCreateErrorIsSnapshotSpecific(controllerGenericNotFound(), "sh-xuixtwzc6swvpu0qjn6q"),
		"a 404 answering a create that carried a snapshot id can only mean the snapshot; "+
			"the prose never says 'snapshot', which is exactly why prose matching failed")
}

func TestGoldenSnapshotDetection_TypedCodesAndNegatives(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name       string
		err        error
		snapshotID string
		want       bool
	}{
		// Layer 1: exact machine-readable codes, at any 4xx.
		{"snapshot_not_found", &sandbox.StatusError{StatusCode: 404, ErrorCode: "snapshot_not_found"}, "snap", true},
		{"snapshot_invalid 400", &sandbox.StatusError{StatusCode: 400, ErrorCode: "snapshot_invalid"}, "snap", true},
		{"snapshot_unavailable 409", &sandbox.StatusError{StatusCode: 409, ErrorCode: "snapshot_unavailable"}, "snap", true},
		{"code field not errorCode", &sandbox.StatusError{StatusCode: 400, Code: "invalid_snapshot"}, "snap", true},
		{"code is case/space insensitive", &sandbox.StatusError{StatusCode: 400, ErrorCode: " Snapshot_Not_Found "}, "snap", true},

		// Layer 2: structural 404 on a snapshot-backed create.
		{"generic 404", controllerGenericNotFound(), "snap", true},
		{"bare 404 no body", &sandbox.StatusError{StatusCode: 404}, "snap", true},

		// Negatives that must never retire a healthy golden pointer.
		{"no snapshot in request", controllerGenericNotFound(), "", false},
		{"blank snapshot in request", controllerGenericNotFound(), "   ", false},
		{"500 with snapshot prose", &sandbox.StatusError{StatusCode: 500, Message: "snapshot missing"}, "snap", false},
		{"503 no capacity", &sandbox.StatusError{StatusCode: 503, ErrorCode: "no_capacity"}, "snap", false},
		{"generic 400 invalid_json", &sandbox.StatusError{StatusCode: 400, ErrorCode: "invalid_json"}, "snap", false},
		{"generic 400 image_required", &sandbox.StatusError{StatusCode: 400, ErrorCode: "image_required"}, "snap", false},
		{"generic 400 idempotency", &sandbox.StatusError{StatusCode: 400, ErrorCode: "idempotency_key_required"}, "snap", false},
		{"403 access denied", &sandbox.StatusError{StatusCode: 403, ErrorCode: "access_denied"}, "snap", false},
		{"not a StatusError", errors.New("dial tcp: i/o timeout"), "snap", false},
		{"nil error", nil, "snap", false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, testCase.want,
				goldenSnapshotCreateErrorIsSnapshotSpecific(testCase.err, testCase.snapshotID))
		})
	}
}

func TestGoldenSnapshotDetection_WrappedErrorStillClassifies(t *testing.T) {
	t.Parallel()

	wrapped := errors.Join(errors.New("create workspace vm"), controllerGenericNotFound())
	assert.True(t, goldenSnapshotCreateErrorIsSnapshotSpecific(wrapped, "snap"),
		"classification must survive wrapping; callers add context to provider errors")
}

// TestWorkspaceService_CreateFreshVM_SelfHealsDanglingGoldenPointer is the
// end-to-end proof for the prod row: with the generic controller envelope, the
// create falls back to bare AND retires the pointer, so the next create stops
// paying for a snapshot that does not exist.
func TestWorkspaceService_CreateFreshVM_SelfHealsDanglingGoldenPointer(t *testing.T) {
	t.Parallel()

	const danglingSnapshot = "sh-xuixtwzc6swvpu0qjn6q"
	goldenDB := &fakeGoldenDB{readyID: danglingSnapshot, readyCreatedAt: time.Now()}
	golden := NewGoldenSnapshotService(goldenDB, nil, nil)

	attempts := 0
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
		WithWorkspaceGoldenSnapshots(golden),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				attempts++
				if req.SnapshotID != "" {
					return sandbox.CreateResult{}, controllerGenericNotFound()
				}
				return sandbox.CreateResult{ID: "vm-bare"}, nil
			},
		}))

	vm, err := svc.createFreshWorkspaceVM(context.Background(), db.Workspace{RepositoryID: 0, ID: "", ProvisioningGeneration: 0, Kind: "container"})
	require.NoError(t, err)
	assert.Equal(t, "vm-bare", vm.ID)
	assert.Equal(t, 2, attempts, "one snapshot attempt, one bare-image retry")
	assert.Equal(t, []string{danglingSnapshot}, goldenDB.markedBadIDs,
		"the dangling pointer MUST be retired; leaving it ready is the 8-day bug")
}

// A tier-wide outage that happens to answer 404 on the bare attempt too must
// still not retire the snapshot: the bare boot has to succeed first.
func TestWorkspaceService_CreateFreshVM_KeepsPointerWhenBareBootAlsoFails(t *testing.T) {
	t.Parallel()

	goldenDB := &fakeGoldenDB{readyID: "snap-live", readyCreatedAt: time.Now()}
	golden := NewGoldenSnapshotService(goldenDB, nil, nil)

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
		WithWorkspaceGoldenSnapshots(golden),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
				return sandbox.CreateResult{}, controllerGenericNotFound()
			},
		}))

	_, err := svc.createFreshWorkspaceVM(context.Background(), db.Workspace{RepositoryID: 0, ID: "", ProvisioningGeneration: 0, Kind: "container"})
	require.Error(t, err)
	assert.Empty(t, goldenDB.markedBadIDs,
		"both attempts failing is a tier problem, not a snapshot problem")
}

// The fork budget must comfortably cover a ~140 MB snapshot export, which is
// unavoidably on the fork critical path. Pinning it stops a future edit from
// silently reinstating a budget that cancels healthy exports mid-stream.
func TestWorkspaceForkTimeout_CoversSnapshotExport(t *testing.T) {
	t.Parallel()

	assert.GreaterOrEqual(t, workspaceForkTimeout, 120*time.Second,
		"forks export ~140 MB before the child boots; the old 30s budget killed exports at ~32s")
	assert.Less(t, workspaceForkTimeout, workspaceProvisionTimeout,
		"a fork must stay bounded and leave room for the cold create+clone fallback")
}
