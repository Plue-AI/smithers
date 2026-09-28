package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/ports"
)

type testLauncher struct {
	lease  Lease
	err    error
	called *bool
}

func (launcher testLauncher) LaunchChatHost(_ context.Context, _ ports.ChatTurnGrant, _ Binding) (Lease, error) {
	if launcher.called != nil {
		*launcher.called = true
	}
	return launcher.lease, launcher.err
}

type testLease struct {
	origin        string
	client        *http.Client
	closed        bool
	closeErr      error
	closeCtxErr   error
	closeDeadline bool
}

type nilClientLease struct{ *testLease }

func (lease nilClientLease) Endpoint() (string, *http.Client, string) {
	return lease.origin, nil, "private-token"
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (run roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return run(request)
}

type failingBody struct {
	closed bool
	err    error
}

func (body *failingBody) Read([]byte) (int, error) { return 0, body.err }
func (body *failingBody) Close() error             { body.closed = true; return nil }

func (lease *testLease) Endpoint() (string, *http.Client, string) {
	if lease.client != nil {
		return lease.origin, lease.client, "private-token"
	}
	return lease.origin, http.DefaultClient, "private-token"
}

func (lease *testLease) Close(ctx context.Context) error {
	lease.closed = true
	lease.closeCtxErr = ctx.Err()
	_, lease.closeDeadline = ctx.Deadline()
	return lease.closeErr
}

func TestHostRefusesMissingDependenciesAndOwnerBeforeSideEffects(t *testing.T) {
	resolver := ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		t.Fatal("resolver called without an authenticated owner")
		return Binding{}, nil
	})
	for _, tc := range []struct {
		name     string
		resolver Resolver
		launcher Launcher
	}{
		{"missing resolver", nil, testLauncher{}},
		{"missing launcher", resolver, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if host, err := New(tc.resolver, tc.launcher); host != nil || err == nil {
				t.Fatalf("New returned host=%v err=%v", host, err)
			}
		})
	}
	called := false
	host, err := New(resolver, testLauncher{called: &called})
	require.NoError(t, err)
	require.ErrorContains(t, host.RunChatTurn(context.Background(), ports.ChatTurnGrant{}), "no authenticated owner")
	stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{})
	require.Nil(t, stream)
	require.ErrorContains(t, err, "no authenticated owner")
	require.False(t, called)
}

func TestHostStopsOnResolverOrLaunchFailure(t *testing.T) {
	resolveErr := errors.New("resolver offline")
	called := false
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, resolveErr
	}), testLauncher{called: &called})
	require.NoError(t, err)
	require.ErrorIs(t, host.RunChatTurn(context.Background(), ports.ChatTurnGrant{OwnerID: 7}), resolveErr)
	stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{}`)})
	require.Nil(t, stream)
	require.ErrorIs(t, err, resolveErr)
	require.False(t, called)

	launchErr := errors.New("host unavailable")
	host, err = New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{err: launchErr, called: &called})
	require.NoError(t, err)
	require.ErrorIs(t, host.RunChatTurn(context.Background(), ports.ChatTurnGrant{OwnerID: 7}), launchErr)
	stream, err = host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{}`)})
	require.Nil(t, stream)
	require.ErrorIs(t, err, launchErr)
	require.True(t, called)
}

func TestModelStreamRejectsMalformedRequestBeforeResolution(t *testing.T) {
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		t.Fatal("resolver called for malformed request")
		return Binding{}, nil
	}), testLauncher{})
	require.NoError(t, err)
	for _, request := range []json.RawMessage{nil, json.RawMessage(`{`), json.RawMessage(`[]`), json.RawMessage(`null`)} {
		stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: request})
		require.Nil(t, stream)
		require.ErrorIs(t, err, ports.ErrModelRequestInvalid)
	}
}

func TestHostClosesLeaseAndPreservesOperationAndCleanupErrors(t *testing.T) {
	cleanupErr := errors.New("cleanup failed")
	transportErr := errors.New("transport failed")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lease := &testLease{origin: "https://private.test", closeErr: cleanupErr, client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		cancel()
		return nil, transportErr
	})}}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	err = host.RunChatTurn(ctx, ports.ChatTurnGrant{OwnerID: 7})
	require.ErrorIs(t, err, transportErr)
	require.ErrorIs(t, err, cleanupErr)
	require.True(t, lease.closed)
	require.NoError(t, lease.closeCtxErr, "cleanup must survive the canceled turn context")
	require.True(t, lease.closeDeadline, "cleanup must remain bounded")
}

func TestModelStreamChecksPrivateRequestAndClosesFailedResponse(t *testing.T) {
	closed := false
	lease := &testLease{origin: "https://private.test/base/", client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		require.Equal(t, http.MethodPost, request.Method)
		require.Equal(t, "https://private.test/base/v1/model/stream", request.URL.String())
		require.Equal(t, "Bearer private-token", request.Header.Get("Authorization"))
		require.Equal(t, "application/json", request.Header.Get("Content-Type"))
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		var sent map[string]any
		require.NoError(t, json.Unmarshal(body, &sent))
		require.Equal(t, float64(7), sent["ownerId"])
		require.NotEmpty(t, sent["runId"])
		return &http.Response{StatusCode: http.StatusTooManyRequests, Body: &trackingReadCloser{Reader: strings.NewReader("retry later"), closed: &closed}, Header: make(http.Header)}, nil
	})}}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{"ownerId":999,"runId":"forged"}`)})
	require.Nil(t, stream)
	require.ErrorContains(t, err, "status 429")
	require.True(t, closed, "failed response body must be closed")
	require.True(t, lease.closed, "lease must be closed before returning")
}

type trackingReadCloser struct {
	io.Reader
	closed *bool
}

func (body *trackingReadCloser) Close() error { *body.closed = true; return nil }

func TestModelStreamClosesBodyAndLeaseAfterReadFailure(t *testing.T) {
	readErr := errors.New("stream broken")
	body := &failingBody{err: readErr}
	lease := &testLease{origin: "https://private.test", client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: body, Header: make(http.Header)}, nil
	})}}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{}`)})
	require.Nil(t, stream)
	require.ErrorIs(t, err, readErr)
	require.True(t, body.closed)
	require.True(t, lease.closed)
}

func TestModelStreamUsesFreshClientWhenLeaseHasNoClient(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		assert.Equal(t, "/v1/model/stream", request.URL.Path)
		assert.Equal(t, "Bearer private-token", request.Header.Get("Authorization"))
		_, _ = io.WriteString(w, `{"type":"delta","text":"ok"}`+"\n")
	}))
	defer server.Close()
	lease := &testLease{origin: server.URL}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: nilClientLease{lease}})
	require.NoError(t, err)
	stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{}`)})
	require.NoError(t, err)
	defer stream.Close()
	body, err := io.ReadAll(stream)
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"delta","text":"ok"}`, strings.TrimSpace(string(body)))
	require.True(t, lease.closed)
}

func TestModelStreamNeverReturnsSilentlyTruncatedNDJSON(t *testing.T) {
	const limit = 16 << 20
	const prefix = `{"type":"delta","text":"`
	const suffix = `"}` + "\n"
	for _, tc := range []struct {
		name string
		size int
		over bool
	}{
		{"one byte below", limit - 1, false},
		{"exactly at limit", limit, false},
		{"one byte above", limit + 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := prefix + strings.Repeat("x", tc.size-len(prefix)-len(suffix)) + suffix
			bodyClosed := false
			cleanupErr := errors.New("cleanup failed")
			lease := &testLease{origin: "https://private.test", client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       &trackingReadCloser{Reader: strings.NewReader(payload), closed: &bodyClosed},
					Header:     make(http.Header),
				}, nil
			})}}
			if tc.over {
				lease.closeErr = cleanupErr
			}
			host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
				return Binding{}, nil
			}), testLauncher{lease: lease})
			require.NoError(t, err)
			stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{}`)})
			if tc.over {
				require.Nil(t, stream)
				require.ErrorIs(t, err, cleanupErr)
				require.ErrorContains(t, err, "model stream response too large")
			} else {
				require.NoError(t, err)
				require.NotNil(t, stream)
				actual, readErr := io.ReadAll(stream)
				require.NoError(t, readErr)
				require.NoError(t, stream.Close())
				if len(actual) != tc.size {
					t.Fatalf("successful stream returned %d bytes of %d", len(actual), tc.size)
				}
				require.True(t, strings.HasSuffix(string(actual), suffix), "successful stream must retain the final NDJSON frame")
			}
			require.True(t, bodyClosed)
			require.True(t, lease.closed)
		})
	}
}

func TestModelStreamCancellationClosesThePrivateLease(t *testing.T) {
	started := make(chan struct{})
	lease := &testLease{origin: "https://private.test", client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		close(started)
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		stream, err := host.RunModelStream(ctx, ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{}`)})
		if stream != nil {
			stream.Close()
		}
		finished <- err
	}()
	<-started
	cancel()
	require.ErrorIs(t, <-finished, context.Canceled)
	require.True(t, lease.closed)
	require.NoError(t, lease.closeCtxErr, "cleanup must survive cancellation")
	require.True(t, lease.closeDeadline)
}

type closableLauncher struct {
	testLauncher
	closed bool
	err    error
}

func (launcher *closableLauncher) Close(context.Context) error {
	launcher.closed = true
	return launcher.err
}

func TestHostCloseDelegatesOptionalLauncherCleanup(t *testing.T) {
	closeErr := errors.New("launcher cleanup failed")
	launcher := &closableLauncher{err: closeErr}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), launcher)
	require.NoError(t, err)
	require.ErrorIs(t, host.Close(context.Background()), closeErr)
	require.True(t, launcher.closed)
	host, err = New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{})
	require.NoError(t, err)
	require.NoError(t, host.Close(context.Background()))
}

func TestHostScopesResolutionAndCleansFailedTurn(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		require.Equal(t, "/v1/chat/turn", request.URL.Path)
		require.Equal(t, "Bearer private-token", request.Header.Get("Authorization"))
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	lease := &testLease{origin: server.URL}
	resolved := false
	host, err := New(ResolverFunc(func(_ context.Context, ownerID, repositoryID int64, request json.RawMessage) (Binding, error) {
		require.EqualValues(t, 7, ownerID)
		require.EqualValues(t, 11, repositoryID)
		require.JSONEq(t, `{"runId":"run-1"}`, string(request))
		resolved = true
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	err = host.RunChatTurn(context.Background(), ports.ChatTurnGrant{
		OwnerID: 7, RepositoryID: 11, Request: json.RawMessage(`{"runId":"run-1"}`),
	})
	require.ErrorContains(t, err, "status 503")
	require.True(t, resolved)
	require.True(t, lease.closed)
}

func TestChatTurnUsesFreshClientWhenLeaseHasNoClient(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/v1/chat/turn", r.URL.Path)
		assert.Equal(t, "Bearer private-token", r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	lease := &testLease{origin: server.URL}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: nilClientLease{lease}})
	require.NoError(t, err)
	require.NoError(t, host.RunChatTurn(context.Background(), ports.ChatTurnGrant{OwnerID: 7, Request: json.RawMessage(`{}`)}))
	require.True(t, lease.closed)
	require.True(t, lease.closeDeadline)
}

func TestChatTurnOutlivesTheLeaseClientTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	lease := &testLease{origin: server.URL, client: &http.Client{Timeout: 50 * time.Millisecond}}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	require.NoError(t, host.RunChatTurn(context.Background(), ports.ChatTurnGrant{OwnerID: 7, Request: json.RawMessage(`{}`)}))
	require.Equal(t, 50*time.Millisecond, lease.client.Timeout)
}

func TestModelStreamUsesOwnerResolverAndPrivateHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		require.Equal(t, "/v1/model/stream", request.URL.Path)
		require.Equal(t, "Bearer private-token", request.Header.Get("Authorization"))
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		require.Contains(t, string(body), `"ownerId":7`)
		require.Contains(t, string(body), `"messages"`)
		_, _ = io.WriteString(w, "{\"type\":\"delta\",\"text\":\"provider token\"}\n")
	}))
	defer server.Close()
	lease := &testLease{origin: server.URL}
	resolved := false
	host, err := New(ResolverFunc(func(_ context.Context, ownerID, repositoryID int64, request json.RawMessage) (Binding, error) {
		require.EqualValues(t, 7, ownerID)
		require.EqualValues(t, 11, repositoryID)
		require.Contains(t, string(request), `"ownerId":7`)
		resolved = true
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{
		OwnerID: 7, RepositoryID: 11, Request: json.RawMessage(`{"messages":[{"role":"user","content":"hi"}]}`),
	})
	require.NoError(t, err)
	defer stream.Close()
	body, err := io.ReadAll(stream)
	require.NoError(t, err)
	require.True(t, strings.Contains(string(body), "provider token"))
	require.True(t, resolved)
	require.True(t, lease.closed)
}
