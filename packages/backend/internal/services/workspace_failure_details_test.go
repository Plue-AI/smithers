package services

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func refusedWorkspaceSandbox() *sandbox.StatusError {
	return &sandbox.StatusError{
		StatusCode: http.StatusServiceUnavailable,
		ErrorCode:  "egress_proxy_unavailable",
		Code:       "egress_proxy_unavailable",
		Message:    "workspace egress proxy is unavailable",
	}
}

// failureNotifyStore is the product store with its status notifications
// captured, so a failed start's published payload can be read.
type failureNotifyStore struct {
	*db.Queries
	notified chan db.NotifyWorkspaceStatusParams
}

func (q failureNotifyStore) NotifyWorkspaceStatus(_ context.Context, arg db.NotifyWorkspaceStatusParams) error {
	var payload map[string]string
	if json.Unmarshal([]byte(arg.Payload), &payload) == nil && payload["status"] == "failed" {
		select {
		case q.notified <- arg:
		default:
		}
	}
	return nil
}

// Since de86a86992 (#3565) creation reserves the branch machine in one
// PostgreSQL transaction behind the activation providers, so a refused
// sandbox's failure is read back from the reserved row.
func refusedSandboxService(t *testing.T) (*WorkspaceService, failureNotifyStore, *pgxpool.Pool, int64, int64) {
	t.Helper()
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	store := failureNotifyStore{Queries: db.New(pool), notified: make(chan db.NotifyWorkspaceStatusParams, 1)}
	svc := newWorkspaceServiceForTests(store, WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
				return sandbox.CreateResult{}, refusedWorkspaceSandbox()
			},
		}))
	return svc, store, pool, user, repo
}

func TestWorkspaceServiceRefusedSandboxPersistsFailureAndMapsSyncCode(t *testing.T) {
	svc, _, pool, user, repo := refusedSandboxService(t)
	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: repo,
		UserID:       user,
		Name:         "refused",
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeEgressProxyUnavailable, apiErr.Code)
	var status, code, message string
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT status, failure_code, failure_message FROM workspaces WHERE repository_id=$1`, repo).Scan(&status, &code, &message))
	assert.Equal(t, "failed", status)
	assert.Equal(t, "egress_proxy_unavailable", code)
	assert.Equal(t, "workspace egress proxy is unavailable", message)
}

func TestWorkspaceServiceAsyncRefusalPublishesFailureDetails(t *testing.T) {
	svc, store, _, user, repo := refusedSandboxService(t)
	response, err := svc.CreateWorkspaceAsync(context.Background(), CreateWorkspaceInput{
		RepositoryID: repo,
		UserID:       user,
		Name:         "refused",
	})
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		row, err := store.GetWorkspace(context.Background(), response.ID)
		return err == nil && row.Status == "failed"
	}, 5*time.Second, 20*time.Millisecond, "the refused start persists its failure")
	failed, err := store.GetWorkspace(context.Background(), response.ID)
	require.NoError(t, err)
	assert.Equal(t, "egress_proxy_unavailable", failed.FailureCode.String)
	assert.Equal(t, "workspace egress proxy is unavailable", failed.FailureMessage.String)

	select {
	case notification := <-store.notified:
		var payload map[string]string
		require.NoError(t, json.Unmarshal([]byte(notification.Payload), &payload))
		assert.Equal(t, "failed", payload["status"])
		assert.Equal(t, "egress_proxy_unavailable", payload["failure_code"])
		assert.Equal(t, "workspace egress proxy is unavailable", payload["failure_message"])
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for failed workspace notification")
	}
}

func TestWorkspaceFailureDetailsAcceptsControllerCodes(t *testing.T) {
	for _, code := range []pkgerrors.Code{
		pkgerrors.CodeEgressProxyUnavailable,
		pkgerrors.CodeSecretDeliveryUnavailable,
		pkgerrors.CodeStaleGeneration,
		pkgerrors.CodeQuiesceFailed,
	} {
		details := workspaceFailureDetailsFor(&sandbox.StatusError{Code: string(code), Message: " refused "})
		assert.Equal(t, code, details.Code)
		assert.Equal(t, "refused", details.Message)
	}

	details := workspaceFailureDetailsFor(assert.AnError)
	assert.Equal(t, workspaceProvisioningFailureCode, details.Code)
	assert.Equal(t, assert.AnError.Error(), details.Message)
}
