package webhook

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The HTTP seam deliberately uses no listener: these tests exercise request
// construction and response ownership independently of sockets and SQL.
type httpUnitTransport func(*http.Request) (*http.Response, error)

func (f httpUnitTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type httpUnitBody struct {
	reader        io.Reader
	closes, bytes int
	closeErr      error
}

func (b *httpUnitBody) Read(p []byte) (int, error) {
	n, e := b.reader.Read(p)
	b.bytes += n
	return n, e
}
func (b *httpUnitBody) Close() error { b.closes++; return b.closeErr }

type httpUnitReadFailure struct{ err error }

func (r httpUnitReadFailure) Read(p []byte) (int, error) {
	copy(p, "partial")
	return min(len(p), 7), r.err
}

func TestDeliverHTTPUnitRequestContract(t *testing.T) {
	t.Parallel()
	for _, secret := range []string{"key", ""} {
		t.Run(fmt.Sprintf("secret=%q", secret), func(t *testing.T) {
			payload := []byte("{\"event\":\"ping\"}\n")
			marker := new(int)
			ctx := context.WithValue(context.Background(), marker, "carried")
			response := &httpUnitBody{reader: strings.NewReader("accepted")}
			calls := 0
			client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				require.Equal(t, "POST", r.Method)
				require.Equal(t, "https://receiver.example/hook?scope=all", r.URL.String())
				require.Equal(t, "carried", r.Context().Value(marker))
				require.Equal(t, int64(len(payload)), r.ContentLength)
				got, err := io.ReadAll(r.Body)
				require.NoError(t, err)
				require.Equal(t, payload, got)
				require.NoError(t, r.Body.Close()) // RoundTripper owns the request body.
				require.Equal(t, "application/json", r.Header.Get("Content-Type"))
				require.Equal(t, "Smithers-Hookshot/1.0", r.Header.Get("User-Agent"))
				require.Equal(t, "ping", r.Header.Get("X-Smithers-Event"))
				require.Equal(t, "receipt-42", r.Header.Get("X-Smithers-Delivery"))
				if secret == "" {
					_, exists := r.Header["X-Smithers-Signature-256"]
					require.False(t, exists)
				} else {
					require.Equal(t, "sha256=e3d88f9e111b72387ab2c53384bbe24102a078bfd55b8bff04b9a5f5386a6e9b", r.Header.Get("X-Smithers-Signature-256"))
				}
				return &http.Response{StatusCode: 202, Body: response}, nil
			})}
			status, body, err := Deliver(ctx, client, DeliveryRequest{URL: "https://receiver.example/hook?scope=all", Secret: secret, EventType: "ping", DeliveryID: "receipt-42", Payload: payload})
			require.NoError(t, err)
			require.Equal(t, 202, status)
			require.Equal(t, "accepted", body)
			require.Equal(t, 1, calls)
			require.Equal(t, 1, response.closes)
		})
	}
}

func TestDeliverHTTPUnitResponseClassesAndBounds(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name        string
		status      int
		input, want string
		read        int
	}{
		{"informational", 101, "switching", "switching", 9},
		{"success", 204, "", "", 0}, {"redirect", 302, "moved", "moved", 5},
		{"client failure", 429, "slow down", "slow down", 9}, {"server failure", 503, "unavailable", "unavailable", 11},
		{"below cap", 200, strings.Repeat("a", 4095), strings.Repeat("a", 4095), 4095},
		{"exact cap", 200, strings.Repeat("a", 4096), strings.Repeat("a", 4096), 4096},
		{"over cap", 200, strings.Repeat("a", 4097), strings.Repeat("a", 4096), 4096},
		{"nul and invalid utf8", 200, "ok\x00\xff\xfe done", "ok\ufffd done", 10},
		{"split utf8 at cap", 200, strings.Repeat("a", 4095) + "€", strings.Repeat("a", 4095) + "\ufffd", 4096},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			response := &httpUnitBody{reader: strings.NewReader(tt.input), closeErr: errors.New("close failed")}
			client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tt.status, Body: response}, nil
			})}
			status, body, err := Deliver(context.Background(), client, DeliveryRequest{URL: "https://receiver.example/"})
			require.NoError(t, err)
			require.Equal(t, tt.status, status)
			require.Equal(t, tt.want, body)
			require.Equal(t, tt.read, response.bytes)
			require.Equal(t, 1, response.closes)
		})
	}
}

func TestDeliverHTTPUnitErrorsAndCancellation(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("transport refused")
	for _, tt := range []struct {
		name, url string
		ctx       context.Context
		want      error
		wantCalls int
	}{
		{"transport", "https://receiver.example/", context.Background(), sentinel, 1},
		{"invalid url", "http://[::1", context.Background(), nil, 0},
		{"nil context", "https://receiver.example/", nil, nil, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) { calls++; return nil, sentinel })}
			status, body, err := Deliver(tt.ctx, client, DeliveryRequest{URL: tt.url})
			require.Error(t, err)
			if tt.want != nil {
				require.ErrorIs(t, err, tt.want)
			}
			require.Zero(t, status)
			require.Empty(t, body)
			require.Equal(t, tt.wantCalls, calls)
		})
	}
	t.Run("default client rejects malformed URL without transport", func(t *testing.T) {
		status, body, err := Deliver(context.Background(), nil, DeliveryRequest{URL: "http://[::1"})
		require.ErrorContains(t, err, "missing ']' in host")
		require.Zero(t, status)
		require.Empty(t, body)
	})

	t.Run("canceled context reaches transport", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		calls := 0
		client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) {
			calls++
			require.ErrorIs(t, r.Context().Err(), context.Canceled)
			return nil, r.Context().Err()
		})}
		status, body, err := Deliver(ctx, client, DeliveryRequest{URL: "https://receiver.example/"})
		require.ErrorIs(t, err, context.Canceled)
		require.Zero(t, status)
		require.Empty(t, body)
		require.Equal(t, 1, calls)
	})
	t.Run("in flight cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		entered := make(chan struct{})
		client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) {
			close(entered)
			<-r.Context().Done()
			return nil, r.Context().Err()
		})}
		type result struct {
			status int
			body   string
			err    error
		}
		completed := make(chan result, 1)
		go func() {
			status, body, err := Deliver(ctx, client, DeliveryRequest{URL: "https://receiver.example/"})
			completed <- result{status, body, err}
		}()
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		select {
		case <-entered:
		case <-deadline.C:
			t.Fatal("request never reached the transport")
		}
		cancel()
		var got result
		select {
		case got = <-completed:
		case <-deadline.C:
			t.Fatal("request did not settle after cancellation")
		}
		require.ErrorIs(t, got.err, context.Canceled)
		require.Zero(t, got.status)
		require.Empty(t, got.body)
	})

	t.Run("partial read failure retains status and closes body", func(t *testing.T) {
		readErr := errors.New("response interrupted")
		response := &httpUnitBody{reader: httpUnitReadFailure{readErr}, closeErr: errors.New("cleanup failed")}
		client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 502, Body: response}, nil
		})}
		status, body, err := Deliver(context.Background(), client, DeliveryRequest{URL: "https://receiver.example/"})
		require.ErrorIs(t, err, readErr)
		require.Equal(t, 502, status)
		require.Empty(t, body)
		require.Equal(t, 7, response.bytes)
		require.Equal(t, 1, response.closes)
	})
}
