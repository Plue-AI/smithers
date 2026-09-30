package repohost

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type gitBytesRecord struct {
	repositoryID, gitBytes int64
	measuredAt             time.Time
}

type recordingPushMeter struct {
	remaining int64
	limited   bool
	budgetErr error
	recordErr error

	mu        sync.Mutex
	budgetFor []int64
	records   chan gitBytesRecord
}

func newRecordingPushMeter(remaining int64, limited bool) *recordingPushMeter {
	return &recordingPushMeter{remaining: remaining, limited: limited, records: make(chan gitBytesRecord, 8)}
}

func (m *recordingPushMeter) GitBytesAllowance(_ context.Context, repositoryID int64) (int64, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.budgetFor = append(m.budgetFor, repositoryID)
	return m.remaining, m.limited, m.budgetErr
}

func (m *recordingPushMeter) RecordGitBytes(_ context.Context, repositoryID, gitBytes int64, measuredAt time.Time) error {
	m.records <- gitBytesRecord{repositoryID: repositoryID, gitBytes: gitBytes, measuredAt: measuredAt}
	return m.recordErr
}

// nextRecord waits for the measurement the client takes after a push.
func (m *recordingPushMeter) nextRecord(t *testing.T) gitBytesRecord {
	t.Helper()
	select {
	case record := <-m.records:
		return record
	case <-time.After(10 * time.Second):
		t.Fatal("the push was never measured")
		return gitBytesRecord{}
	}
}

func (m *recordingPushMeter) noRecord(t *testing.T) {
	t.Helper()
	select {
	case record := <-m.records:
		t.Fatalf("unexpected measurement %+v", record)
	case <-time.After(200 * time.Millisecond):
	}
}

// pushHost answers receive-pack with status and git/size with size.
type pushHost struct {
	status    int
	size      string
	sizeDelay time.Duration

	mu   sync.Mutex
	push http.Header
	pack []byte
}

func newPushHost(t *testing.T, status int, size string) (*pushHost, *httptest.Server) {
	t.Helper()
	host := &pushHost{status: status, size: size}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/alice/demo/git/receive-pack":
			pack, _ := io.ReadAll(r.Body)
			host.mu.Lock()
			host.push, host.pack = r.Header.Clone(), pack
			host.mu.Unlock()
			w.WriteHeader(host.status)
			_, _ = w.Write([]byte("result"))
		case "/repos/alice/demo/git/size":
			host.mu.Lock()
			delay := host.sizeDelay
			host.mu.Unlock()
			time.Sleep(delay)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(host.size))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return host, server
}

func (h *pushHost) pushHeader() http.Header {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.push
}

func meteredClient(url string, meter PushMeter) *Client {
	client := NewClient(&StaticStorageSetResolver{URL: url}, "token")
	if meter != nil {
		client.SetPushMeter(meter)
	}
	return client
}

// smithersai/plue#593: a metered push carries the repository's git bytes
// allowance, and the repository is measured and recorded once the push is
// over.
func TestClient_ProxyReceivePack_MetersGitStorage(t *testing.T) {
	host, server := newPushHost(t, http.StatusOK, `{"git_bytes":4096,"measured_at":1700000000000000042}`)
	meter := newRecordingPushMeter(1234, true)

	var out bytes.Buffer
	require.NoError(t, meteredClient(server.URL, meter).ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), &out, ReceivePackMetadata{RepositoryID: 7}))

	assert.Equal(t, "result", out.String())
	assert.Equal(t, "1234", host.pushHeader().Get(GitBytesAllowanceHeader))
	assert.Equal(t, []int64{7}, meter.budgetFor)
	record := meter.nextRecord(t)
	assert.Equal(t, int64(7), record.repositoryID)
	assert.Equal(t, int64(4096), record.gitBytes)
	assert.True(t, record.measuredAt.Equal(time.Unix(0, 1700000000000000042)), record.measuredAt)
}

func TestClient_ProxyReceivePack_UnlimitedOwnerSendsNoStorageCap(t *testing.T) {
	host, server := newPushHost(t, http.StatusOK, `{"git_bytes":10,"measured_at":1}`)
	meter := newRecordingPushMeter(0, false)

	require.NoError(t, meteredClient(server.URL, meter).ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), io.Discard, ReceivePackMetadata{RepositoryID: 7}))

	assert.Empty(t, host.pushHeader().Get(GitBytesAllowanceHeader))
	assert.Equal(t, int64(10), meter.nextRecord(t).gitBytes)
}

// Metering fails closed: a push whose budget cannot be read never reaches
// repo-host and is not measured.
func TestClient_ProxyReceivePack_BudgetFailureStopsThePush(t *testing.T) {
	host, server := newPushHost(t, http.StatusOK, `{"git_bytes":1,"measured_at":1}`)
	boom := errors.New("billing store down")
	meter := newRecordingPushMeter(0, false)
	meter.budgetErr = boom

	err := meteredClient(server.URL, meter).ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), io.Discard, ReceivePackMetadata{RepositoryID: 7})

	require.ErrorIs(t, err, boom)
	assert.Nil(t, host.pushHeader())
	meter.noRecord(t)
}

// A refused push, or one whose caller left, can still leave objects, so it is
// measured too.
func TestClient_ProxyReceivePack_MeasuresPushesThatFail(t *testing.T) {
	_, refused := newPushHost(t, http.StatusRequestEntityTooLarge, `{"git_bytes":300,"measured_at":1}`)
	meter := newRecordingPushMeter(1, true)
	require.Error(t, meteredClient(refused.URL, meter).ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), io.Discard, ReceivePackMetadata{RepositoryID: 7}))
	assert.Equal(t, int64(300), meter.nextRecord(t).gitBytes)

	ctx, cancel := context.WithCancel(context.Background())
	bodyRead := make(chan struct{})
	left := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/alice/demo/git/size" {
			_, _ = w.Write([]byte(`{"git_bytes":700,"measured_at":5}`))
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		close(bodyRead)
		<-r.Context().Done()
	}))
	t.Cleanup(left.Close)
	go func() {
		<-bodyRead
		cancel()
	}()
	require.Error(t, meteredClient(left.URL, meter).ProxyReceivePack(ctx, "alice", "demo", bytes.NewBufferString("pack"), io.Discard, ReceivePackMetadata{RepositoryID: 7}))
	assert.Equal(t, int64(700), meter.nextRecord(t).gitBytes)
}

// The push is decided when it ends, so a failed or malformed measurement
// never fails it.
func TestClient_ProxyReceivePack_MeasurementNeverFailsThePush(t *testing.T) {
	for name, tc := range map[string]struct {
		size      string
		recordErr error
		records   int
	}{
		"record fails":   {size: `{"git_bytes":5,"measured_at":1}`, recordErr: errors.New("db down"), records: 1},
		"negative bytes": {size: `{"git_bytes":-3,"measured_at":1}`},
		"no time":        {size: `{"git_bytes":5}`},
		"malformed":      {size: `lots`},
	} {
		t.Run(name, func(t *testing.T) {
			_, server := newPushHost(t, http.StatusOK, tc.size)
			meter := newRecordingPushMeter(0, false)
			meter.recordErr = tc.recordErr

			require.NoError(t, meteredClient(server.URL, meter).ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), io.Discard, ReceivePackMetadata{RepositoryID: 7}))
			if tc.records == 1 {
				meter.nextRecord(t)
			} else {
				meter.noRecord(t)
			}
		})
	}
}

// A push without a repository ID or without a meter is not metered.
func TestClient_ProxyReceivePack_MetersOnlyAttributedPushes(t *testing.T) {
	host, server := newPushHost(t, http.StatusOK, `{"git_bytes":9,"measured_at":1}`)
	meter := newRecordingPushMeter(1, true)
	require.NoError(t, meteredClient(server.URL, meter).ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), io.Discard))
	assert.Empty(t, host.pushHeader().Get(GitBytesAllowanceHeader))
	assert.Empty(t, meter.budgetFor)
	meter.noRecord(t)

	require.NoError(t, meteredClient(server.URL, nil).ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), io.Discard, ReceivePackMetadata{RepositoryID: 7}))
	assert.Empty(t, host.pushHeader().Get(GitBytesAllowanceHeader))
}

// The measurement waits for the repository as long as a push may hold it,
// not the client's read bound.
func TestClient_ProxyReceivePack_MeasurementOutwaitsTheReadBound(t *testing.T) {
	host, server := newPushHost(t, http.StatusOK, `{"git_bytes":64,"measured_at":1}`)
	host.mu.Lock()
	host.sizeDelay = 300 * time.Millisecond
	host.mu.Unlock()
	meter := newRecordingPushMeter(1, true)
	client := meteredClient(server.URL, meter)
	client.readTimeout = 50 * time.Millisecond

	require.NoError(t, client.ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), io.Discard, ReceivePackMetadata{RepositoryID: 7}))
	assert.Equal(t, int64(64), meter.nextRecord(t).gitBytes)
}

// Pushes that end while their repository's measurement waits share one more
// pass, so a busy repository holds one measurement at a time.
func TestClient_ProxyReceivePack_CoalescesMeasurementsPerRepository(t *testing.T) {
	var sizeCalls int
	var mu sync.Mutex
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/alice/demo/git/size" {
			mu.Lock()
			sizeCalls++
			call := sizeCalls
			mu.Unlock()
			if call == 1 {
				<-release
			}
			_, _ = fmt.Fprintf(w, `{"git_bytes":%d,"measured_at":%d}`, call, call)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
	}))
	t.Cleanup(server.Close)
	meter := newRecordingPushMeter(1, true)
	client := meteredClient(server.URL, meter)

	for range 5 {
		require.NoError(t, client.ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), io.Discard, ReceivePackMetadata{RepositoryID: 7}))
	}
	require.Eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return sizeCalls == 1 }, 5*time.Second, 10*time.Millisecond)
	close(release)

	assert.Equal(t, int64(1), meter.nextRecord(t).gitBytes)
	assert.Equal(t, int64(2), meter.nextRecord(t).gitBytes, "the pushes that ended during the first pass share one more")
	meter.noRecord(t)
	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, 2, sizeCalls)
}
