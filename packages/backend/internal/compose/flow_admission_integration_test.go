package compose

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// Only the external launch transport is a test endpoint. It refuses every
// launch; no fabricated successful host, workflow, identity or receipt exists.
type refusingHostTransport struct{ url string }

func (refusingHostTransport) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}

func (refusingHostTransport) InspectFlowHost(context.Context, flowhost.HostLaunch) (flowhost.Connection, error) {
	return flowhost.Connection{}, flowhost.ErrHostNotRunning
}
func (r refusingHostTransport) StartFlowHost(ctx context.Context, _ flowhost.HostLaunch) (flowhost.Connection, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, nil)
	if err != nil {
		return flowhost.Connection{}, err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return flowhost.Connection{}, err
	}
	defer response.Body.Close()
	return flowhost.Connection{}, fmt.Errorf("external host refused launch: HTTP %d", response.StatusCode)
}
func (refusingHostTransport) ResolveFlowHostSource(context.Context, flowhost.Authority) (string, error) {
	return "", errors.New("test requires an existing source revision")
}
func (refusingHostTransport) StopFlowHost(context.Context, flowhost.Binding) error { return nil }

func TestFlowWorkerRechecksMeteredAdmissionBeforeHostLaunch(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	var owner, repo, otherRepo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email,display_name) VALUES ('worker','worker','worker@example.test','worker@example.test','Worker') RETURNING id`).Scan(&owner))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public,default_bookmark) VALUES ($1,'repo','repo',false,'main') RETURNING id`, owner).Scan(&repo))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public,default_bookmark) VALUES ($1,'other','other',false,'main') RETURNING id`, owner).Scan(&otherRepo))
	workspace, other := uuid.NewString(), uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,vm_id,status) VALUES ($1,$2,$3,'owned','running'),($4,$5,$3,'other','running')`, workspace, repo, owner, other, otherRepo)
	require.NoError(t, err)
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage, Prices: admission.Prices{ProMonthly: "price_pro"}})
	require.NoError(t, err)
	var attempts atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	launcher, err := newAdmittedFlowLauncher(refusingHostTransport{server.URL}, db.New(pool), policy)
	require.NoError(t, err)
	codec, err := newSecretCodec(config.WebhookConfig{SecretEncryptionKey: "integration-only-secret"})
	require.NoError(t, err)
	bindings, err := flowhost.NewStore(pool, codec)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, BindingKind: "browser-flow", BindingID: "worker/repo", WorkspaceID: workspace}
	resolver, err := flowhost.New(flowhost.Config{Store: bindings, Launcher: launcher, Targets: flowhost.TargetResolverFunc(func(_ context.Context, got flowruntime.Target) (flowhost.Authority, error) {
		if got != target {
			return flowhost.Authority{}, errors.New("unexpected target")
		}
		return flowhost.Authority{Target: target, RepositoryID: repo, UserID: owner, WorkspaceID: workspace, CatalogKey: flowhost.CatalogCoding, Repository: "worker/repo", SourceRevision: strings.Repeat("a", 40)}, nil
	}), Catalogs: []flowhost.Catalog{{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/unavailable/test-host", ArtifactDigest: strings.Repeat("b", 64), ServiceName: "coding-host"}}})
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	worker, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: resolver})
	require.NoError(t, err)
	workerCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- worker.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "key-free-worker", Capacity: 1, Lease: 3 * time.Second, PollInterval: 10 * time.Millisecond, RetryDelay: 10 * time.Millisecond, MaxRetryDelay: 100 * time.Millisecond})
	}()
	defer func() { stop(); require.NoError(t, <-done) }()
	dispatch := func(request string) jobs.RequestReceipt {
		receipt, err := worker.Admit(ctx, flowdispatch.LaunchRequest{Scope: scope, RequestID: request, Target: target, FlowID: "coding/change", Payload: []byte(`{}`), AuthorizationContext: []byte(`{}`)})
		require.NoError(t, err)
		return receipt
	}
	waitRefused := func(receipt jobs.RequestReceipt) {
		require.Eventually(t, func() bool {
			var failure string
			err := pool.QueryRow(ctx, `SELECT last_error FROM product_job_dispatches WHERE operation_id=$1`, receipt.OperationID).Scan(&failure)
			return err == nil && failure != ""
		}, 8*time.Second, 10*time.Millisecond)
	}
	exhausted := dispatch("exhausted")
	waitRefused(exhausted)
	require.Zero(t, attempts.Load(), "exhausted worker must refuse before contacting launch transport")
	var account int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO billing_accounts(owner_type,owner_id,stripe_customer_id) VALUES ('user',$1,'cus_worker') RETURNING id`, owner).Scan(&account))
	_, err = pool.Exec(ctx, `INSERT INTO billing_subscriptions(billing_account_id,stripe_subscription_id,stripe_price_id,plan_key,billing_interval,status,quantity) VALUES ($1,'sub_worker','price_pro','pro','monthly','active',1)`, account)
	require.NoError(t, err)
	// The same durable request becomes eligible after the projection changes;
	// neither its policy nor its worker process is reconstructed.
	require.Eventually(t, func() bool { return attempts.Load() > 0 }, 8*time.Second, 10*time.Millisecond)
	_, err = store.RequestCancellation(ctx, scope, exhausted.OperationID)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		operation, err := store.Get(ctx, scope, exhausted.OperationID)
		return err == nil && operation.State.Terminal()
	}, 8*time.Second, 10*time.Millisecond)
	contacted := attempts.Load()
	_, err = pool.Exec(ctx, `UPDATE billing_subscriptions SET status='canceled' WHERE billing_account_id=$1`, account)
	require.NoError(t, err)
	canceled := dispatch("canceled")
	waitRefused(canceled)
	require.Equal(t, contacted, attempts.Load(), "same running worker must observe cancellation and refuse before launch")
}
