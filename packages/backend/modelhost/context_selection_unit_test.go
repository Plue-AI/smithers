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

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/ports"
)

// Literal selector input and result for a TODO plan step (T-FLW-10).
const selectionInput = `{"prompt":"Retry failed webhook deliveries","author":"ben","branch":"todo:12","state":"plan","recent":[],"candidates":[{"item":{"kind":"page","label":"Retry policy","ref":"retry-policy","revision":"3"},"text":"Webhook retries use retry() with exponential backoff."}],"tokenBudget":24000,"wikiOnly":true}`
const selectionResult = `{"context":[{"kind":"page","label":"Retry policy","ref":"retry-policy","revision":"3","reason":"Retry decision"}],"candidates":[{"kind":"page","label":"Retry policy","ref":"retry-policy","revision":"3"}],"model":"owner-fast","durationMs":4}`

func TestSelectContextRunsTheOwnerSelectorInAPrivateHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		require.Equal(t, "/v1/context/select", request.URL.Path)
		require.Equal(t, "Bearer private-token", request.Header.Get("Authorization"))
		var body map[string]json.RawMessage
		require.NoError(t, json.NewDecoder(request.Body).Decode(&body))
		require.JSONEq(t, selectionInput, string(body["contextSelection"]))
		require.JSONEq(t, `7`, string(body["ownerId"]))
		require.JSONEq(t, `""`, string(body["instructions"]))
		require.JSONEq(t, `[]`, string(body["messages"]))
		_, _ = io.WriteString(w, selectionResult)
	}))
	defer server.Close()
	lease := &testLease{origin: server.URL}
	var resolvedRequest json.RawMessage
	host, err := New(ResolverFunc(func(_ context.Context, ownerID, repositoryID int64, request json.RawMessage) (Binding, error) {
		require.EqualValues(t, 7, ownerID)
		require.EqualValues(t, 11, repositoryID)
		resolvedRequest = request
		return Binding{Preflight: &Binding{}}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	result, err := host.SelectContext(context.Background(), ports.ContextSelectionGrant{OwnerID: 7, RepositoryID: 11, Input: json.RawMessage(selectionInput)})
	require.NoError(t, err)
	require.JSONEq(t, selectionResult, string(result))
	// The owner resolver sees the selection marker, which resolves the fast role.
	require.Contains(t, string(resolvedRequest), `"contextSelection":{"prompt":"Retry failed webhook deliveries"`)
	require.True(t, lease.closed)
}

func TestSelectContextRefusesBeforeSideEffects(t *testing.T) {
	launched := false
	resolved := false
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		resolved = true
		return Binding{Managed: true}, nil
	}), testLauncher{called: &launched})
	require.NoError(t, err)
	_, err = host.SelectContext(context.Background(), ports.ContextSelectionGrant{Input: json.RawMessage(selectionInput)})
	require.ErrorContains(t, err, "no authenticated owner")
	for _, input := range []string{"", "[]", "{", `"prompt"`} {
		_, err = host.SelectContext(context.Background(), ports.ContextSelectionGrant{OwnerID: 7, Input: json.RawMessage(input)})
		require.ErrorIs(t, err, ports.ErrModelRequestInvalid, input)
	}
	require.False(t, resolved)
	// Managed credit is metered per chat turn; a selection has none.
	_, err = host.SelectContext(context.Background(), ports.ContextSelectionGrant{OwnerID: 7, Input: json.RawMessage(selectionInput)})
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
	require.True(t, resolved)
	require.False(t, launched)
	resolveErr := errors.New("resolver offline")
	host, err = New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, resolveErr
	}), testLauncher{called: &launched})
	require.NoError(t, err)
	_, err = host.SelectContext(context.Background(), ports.ContextSelectionGrant{OwnerID: 7, Input: json.RawMessage(selectionInput)})
	require.ErrorIs(t, err, resolveErr)
	require.False(t, launched)
}

func TestSelectContextRefusesHostFailuresAndClosesTheLease(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   error
		text   string
	}{
		{"validation", http.StatusBadRequest, `{"status":"error","code":"request_invalid"}`, ports.ErrModelRequestInvalid, ""},
		{"provider", http.StatusBadGateway, `{"status":"error","code":"turn_failed"}`, nil, "status 502"},
		{"invalid json", http.StatusOK, `{"context":`, nil, "response is invalid"},
		{"oversized", http.StatusOK, `"` + strings.Repeat("a", maxContextSelectionBytes) + `"`, nil, "response is invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			lease := &testLease{origin: server.URL}
			host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
				return Binding{}, nil
			}), testLauncher{lease: lease})
			require.NoError(t, err)
			result, err := host.SelectContext(context.Background(), ports.ContextSelectionGrant{OwnerID: 7, Input: json.RawMessage(selectionInput)})
			require.Nil(t, result)
			if tc.want != nil {
				require.ErrorIs(t, err, tc.want)
			} else {
				require.ErrorContains(t, err, tc.text)
			}
			require.True(t, lease.closed)
		})
	}
}
