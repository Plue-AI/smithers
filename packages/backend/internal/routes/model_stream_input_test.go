package routes

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/ports"
)

type responseModelLease struct {
	server *httptest.Server
	closed bool
}

func (l *responseModelLease) Endpoint() (string, *http.Client, string) {
	return l.server.URL, l.server.Client(), "private-token"
}

func (l *responseModelLease) Close(context.Context) error {
	l.closed = true
	return errors.New("cleanup failure")
}

type responseModelLauncher struct{ lease *responseModelLease }

func (l responseModelLauncher) LaunchChatHost(context.Context, ports.ChatTurnGrant, modelhost.Binding) (modelhost.Lease, error) {
	return l.lease, nil
}

func TestModelStreamClassifiesPrivateHostRefusals(t *testing.T) {
	for _, tc := range []struct {
		upstream int
		status   int
		code     string
	}{
		{http.StatusBadRequest, http.StatusBadRequest, "request_invalid"},
		{http.StatusUnauthorized, http.StatusBadGateway, "model_unavailable"},
		{http.StatusTooManyRequests, http.StatusBadGateway, "model_unavailable"},
		{http.StatusBadGateway, http.StatusBadGateway, "model_unavailable"},
	} {
		t.Run(http.StatusText(tc.upstream), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, "/v1/model/stream", r.URL.Path)
				w.WriteHeader(tc.upstream)
				_, _ = io.WriteString(w, `{"status":"error"}`)
			}))
			defer server.Close()
			lease := &responseModelLease{server: server}
			host, err := modelhost.New(modelhost.ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (modelhost.Binding, error) {
				return modelhost.Binding{}, nil
			}), responseModelLauncher{lease})
			require.NoError(t, err)
			w := httptest.NewRecorder()
			NewModelStreamHandler(host).ServeHTTP(w, signedIn(httptest.NewRequest(http.MethodPost, "/api/model/stream", strings.NewReader(`{}`))))
			require.Equal(t, tc.status, w.Code)
			require.JSONEq(t, `{"status":"error","code":"`+tc.code+`"}`, w.Body.String())
			require.True(t, lease.closed)
		})
	}
}

type unexpectedModelLauncher struct{ t *testing.T }

func (l unexpectedModelLauncher) LaunchChatHost(context.Context, ports.ChatTurnGrant, modelhost.Binding) (modelhost.Lease, error) {
	l.t.Fatal("invalid request launched a host")
	return nil, nil
}

func TestModelStreamRejectsInvalidJSONObjects(t *testing.T) {
	for _, body := range []string{"{", "null", "[]", `"text"`, "1", "true", "false", "{} {}", "{} trailing"} {
		t.Run(body, func(t *testing.T) {
			host, err := modelhost.New(modelhost.ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (modelhost.Binding, error) {
				t.Fatal("invalid request reached model resolution")
				return modelhost.Binding{}, nil
			}), unexpectedModelLauncher{t})
			require.NoError(t, err)
			r := signedIn(httptest.NewRequest(http.MethodPost, "/api/model/stream", strings.NewReader(body)))
			w := httptest.NewRecorder()
			NewModelStreamHandler(host).ServeHTTP(w, r)
			require.Equal(t, http.StatusBadRequest, w.Code)
			require.JSONEq(t, `{"status":"error","code":"request_invalid"}`, w.Body.String())
		})
	}
}

type recordingModelStream struct{ request ports.ModelStreamGrant }

func (h *recordingModelStream) RunModelStream(_ context.Context, grant ports.ModelStreamGrant) (io.ReadCloser, error) {
	h.request = grant
	return io.NopCloser(strings.NewReader("{}\n")), nil
}

func TestModelStreamPreservesObjectBytesAtPortBoundaryAndLeavesSchemaToHost(t *testing.T) {
	for _, body := range []string{`{}`, " \n{\"messages\":[],\"number\":9007199254740993,\"future\":1e1000} \t"} {
		host := &recordingModelStream{}
		w := httptest.NewRecorder()
		NewModelStreamHandler(host).ServeHTTP(w, signedIn(httptest.NewRequest(http.MethodPost, "/api/model/stream", strings.NewReader(body))))
		require.Equal(t, http.StatusOK, w.Code)
		require.Equal(t, body, string(host.request.Request))
		require.EqualValues(t, 42, host.request.OwnerID)
	}
}

func TestModelStreamChecksMethodAndAuthenticationBeforeJSON(t *testing.T) {
	for _, tc := range []struct {
		method string
		status int
	}{{http.MethodGet, http.StatusMethodNotAllowed}, {http.MethodPost, http.StatusUnauthorized}} {
		w := httptest.NewRecorder()
		NewModelStreamHandler(nil).ServeHTTP(w, httptest.NewRequest(tc.method, "/api/model/stream", strings.NewReader("{")))
		require.Equal(t, tc.status, w.Code)
	}
}
