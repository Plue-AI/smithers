package repohost

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// provisionTestMeter is a ProvisionMeter that records which owner it was
// asked about and what it was asked to record.
type provisionTestMeter struct {
	*recordingPushMeter
	owners   []string
	recorded []provisionedGitBytes
}

type provisionedGitBytes struct {
	owner, repo string
	gitBytes    int64
	measuredAt  time.Time
}

func newProvisionTestMeter(remaining int64, limited bool) *provisionTestMeter {
	return &provisionTestMeter{recordingPushMeter: newRecordingPushMeter(remaining, limited)}
}

func (m *provisionTestMeter) OwnerGitBytesAllowance(_ context.Context, owner string) (int64, bool, error) {
	m.owners = append(m.owners, owner)
	return m.remaining, m.limited, m.budgetErr
}

func (m *provisionTestMeter) RecordProvisionedGitBytes(_ context.Context, owner, repo string, gitBytes int64, measuredAt time.Time) error {
	if m.recordErr != nil {
		return m.recordErr
	}
	m.recorded = append(m.recorded, provisionedGitBytes{owner: owner, repo: repo, gitBytes: gitBytes, measuredAt: measuredAt})
	return nil
}

// provisionHost answers the staged provisioning routes and records the
// requests it saw, in order.
type provisionHost struct {
	t    *testing.T
	size string

	mu       sync.Mutex
	requests []string
	headers  map[string]http.Header
}

func newProvisionHost(t *testing.T) (*provisionHost, *Client) {
	t.Helper()
	host := &provisionHost{t: t, size: `{"git_bytes":4096,"measured_at":1000000000}`, headers: map[string]http.Header{}}
	server := httptest.NewServer(host)
	t.Cleanup(server.Close)
	return host, NewClient(&StaticStorageSetResolver{URL: server.URL}, "secret")
}

func (h *provisionHost) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	h.requests = append(h.requests, r.Method+" "+r.URL.Path)
	h.headers[r.URL.Path] = r.Header.Clone()
	h.mu.Unlock()
	switch r.URL.Path {
	case "/repos/provision-stages":
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"token":"stage-token","phase":"ready"}`))
	case "/repos/bob/copy/git/size":
		_, _ = w.Write([]byte(h.size))
	case "/repos/provision-stages/stage-token/finalize":
		w.WriteHeader(http.StatusNoContent)
	default:
		h.t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}
}

func (h *provisionHost) seen() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.requests...)
}

func (h *provisionHost) allowance(path string) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.headers[path].Values(GitBytesAllowanceHeader)
}

func stagedProvision(operation string) StagedProvision {
	staged := StagedProvision{StorageSetID: "local", Token: "stage-token", OperationType: operation, Owner: "bob", Repo: "copy"}
	if operation == provisionOperationFork {
		staged.SrcOwner, staged.SrcRepo = "alice", "source"
	}
	return staged
}

// smithersai/plue#768: a staged fork copies its source into the destination
// owner's storage, so repo-host needs the destination owner's allowance.
func TestStagedForkSendsTheDestinationOwnersAllowance(t *testing.T) {
	for name, tc := range map[string]struct {
		remaining int64
		limited   bool
		want      []string
	}{
		"room left":      {remaining: 8192, limited: true, want: []string{"8192"}},
		"at the limit":   {remaining: 0, limited: true, want: []string{"0"}},
		"over the limit": {remaining: -5, limited: true, want: []string{"0"}},
		"no limit":       {remaining: 0, limited: false, want: nil},
	} {
		t.Run(name, func(t *testing.T) {
			host, client := newProvisionHost(t)
			meter := newProvisionTestMeter(tc.remaining, tc.limited)
			client.SetPushMeter(meter)

			require.NoError(t, client.ExecuteStagedProvision(context.Background(), stagedProvision(provisionOperationFork)))

			assert.Equal(t, tc.want, host.allowance("/repos/provision-stages"))
			assert.Equal(t, []string{"bob"}, meter.owners, "the allowance is the destination owner's, not the source's")
		})
	}
}

// Creating an empty repository or an import stage adds no git objects; the
// import's objects arrive with its mirror push (StagedProvisionGitHeaders).
func TestStagedInitAndImportStagesReadNoAllowance(t *testing.T) {
	for _, operation := range []string{provisionOperationInit, provisionOperationImport} {
		t.Run(operation, func(t *testing.T) {
			host, client := newProvisionHost(t)
			meter := newProvisionTestMeter(8192, true)
			client.SetPushMeter(meter)

			require.NoError(t, client.ExecuteStagedProvision(context.Background(), stagedProvision(operation)))

			assert.Empty(t, host.allowance("/repos/provision-stages"))
			assert.Empty(t, meter.owners)
		})
	}
}

func TestStagedForkFailsClosedBeforeContactingTheHost(t *testing.T) {
	t.Run("allowance unavailable", func(t *testing.T) {
		host, client := newProvisionHost(t)
		meter := newProvisionTestMeter(0, true)
		meter.budgetErr = errors.New("owner usage unavailable")
		client.SetPushMeter(meter)

		err := client.ExecuteStagedProvision(context.Background(), stagedProvision(provisionOperationFork))

		require.ErrorIs(t, err, meter.budgetErr)
		assert.Empty(t, host.seen())
	})
	t.Run("meter cannot meter provisioning", func(t *testing.T) {
		host, client := newProvisionHost(t)
		client.SetPushMeter(newRecordingPushMeter(8192, true))

		err := client.ExecuteStagedProvision(context.Background(), stagedProvision(provisionOperationFork))

		require.ErrorContains(t, err, "cannot meter repository provisioning")
		assert.Empty(t, host.seen())
	})
	t.Run("no meter keeps today's behavior", func(t *testing.T) {
		host, client := newProvisionHost(t)

		require.NoError(t, client.ExecuteStagedProvision(context.Background(), stagedProvision(provisionOperationFork)))

		assert.Empty(t, host.allowance("/repos/provision-stages"))
		assert.Equal(t, []string{"POST /repos/provision-stages"}, host.seen())
	})
}

// The import's mirror push runs in a git subprocess, so the client hands the
// caller the headers that push must carry.
func TestStagedImportPushHeadersCarryTheDestinationOwnersAllowance(t *testing.T) {
	_, client := newProvisionHost(t)
	meter := newProvisionTestMeter(8192, true)
	client.SetPushMeter(meter)

	headers, err := client.StagedProvisionGitHeaders(context.Background(), stagedProvision(provisionOperationImport))

	require.NoError(t, err)
	assert.Equal(t, []string{"8192"}, headers.Values(GitBytesAllowanceHeader))
	assert.Equal(t, []string{"bob"}, meter.owners)

	meter.limited = false
	headers, err = client.StagedProvisionGitHeaders(context.Background(), stagedProvision(provisionOperationImport))
	require.NoError(t, err)
	assert.Empty(t, headers.Values(GitBytesAllowanceHeader))

	meter.budgetErr = errors.New("owner usage unavailable")
	_, err = client.StagedProvisionGitHeaders(context.Background(), stagedProvision(provisionOperationImport))
	require.ErrorIs(t, err, meter.budgetErr)

	_, err = client.StagedProvisionGitHeaders(context.Background(), stagedProvision(provisionOperationFork))
	require.ErrorContains(t, err, "require an import provision")
}

// A published fork or import records its git bytes before its journal is
// finalized, so the owner's next admission counts them. A failed record
// keeps the journal, and the finalize is retried.
func TestFinalizeRecordsProvisionedGitBytesBeforeTheJournalEnds(t *testing.T) {
	for _, operation := range []string{provisionOperationFork, provisionOperationImport} {
		t.Run(operation, func(t *testing.T) {
			host, client := newProvisionHost(t)
			meter := newProvisionTestMeter(8192, true)
			client.SetPushMeter(meter)
			staged := stagedProvision(operation)

			meter.recordErr = errors.New("ledger unavailable")
			require.ErrorIs(t, client.FinalizeStagedProvision(context.Background(), staged), meter.recordErr)
			assert.Equal(t, []string{"GET /repos/bob/copy/git/size"}, host.seen(), "the journal must remain until the bytes are recorded")

			meter.recordErr = nil
			require.NoError(t, client.FinalizeStagedProvision(context.Background(), staged))
			assert.Equal(t, []provisionedGitBytes{{owner: "bob", repo: "copy", gitBytes: 4096, measuredAt: time.Unix(0, 1000000000)}}, meter.recorded)
			assert.Equal(t, []string{
				"GET /repos/bob/copy/git/size",
				"GET /repos/bob/copy/git/size", "POST /repos/provision-stages/stage-token/finalize",
			}, host.seen())
		})
	}
}

func TestFinalizeRefusesAMalformedMeasurement(t *testing.T) {
	for _, size := range []string{`{"git_bytes":-1,"measured_at":1000000000}`, `{"git_bytes":4096,"measured_at":0}`} {
		host, client := newProvisionHost(t)
		host.size = size
		meter := newProvisionTestMeter(8192, true)
		client.SetPushMeter(meter)

		require.Error(t, client.FinalizeStagedProvision(context.Background(), stagedProvision(provisionOperationFork)))

		assert.Empty(t, meter.recorded)
		assert.NotContains(t, host.seen(), "POST /repos/provision-stages/stage-token/finalize")
	}
}

func TestFinalizeMeasuresNothingAnInitAdds(t *testing.T) {
	host, client := newProvisionHost(t)
	meter := newProvisionTestMeter(8192, true)
	client.SetPushMeter(meter)

	require.NoError(t, client.FinalizeStagedProvision(context.Background(), stagedProvision(provisionOperationInit)))

	assert.Empty(t, meter.recorded)
	assert.Equal(t, []string{"POST /repos/provision-stages/stage-token/finalize"}, host.seen())
}

// Whatever the caller makes of repo-host refusing a fork over the storage
// limit, the request answers 402 plan_limit_exceeded, as a push does
// (middleware.DependencyRefusals).
func TestStorageRefusalIsRecordedAsThePlanLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Smithers-Error-Code", StorageLimitCode)
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_, _ = w.Write([]byte(`{"code":"storage_limit_exceeded","message":"this fork would exceed the storage limit for the current plan"}`))
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "secret")
	ctx := apierrors.WithRefusalRecorder(context.Background())

	err := client.ExecuteStagedProvision(ctx, stagedProvision(provisionOperationFork))

	status, ok := IsStatusError(err)
	require.True(t, ok, "%v", err)
	assert.Equal(t, StorageLimitCode, status.Code)
	refusal := apierrors.RecordedRefusal(ctx)
	require.NotNil(t, refusal)
	assert.Equal(t, http.StatusPaymentRequired, refusal.Status)
	assert.Equal(t, apierrors.CodePlanLimitExceeded, refusal.Code)
	assert.Equal(t, "storage_bytes", refusal.LimitKind)
}
