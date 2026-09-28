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

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
)

type fixtureTester func(context.Context, int64, json.RawMessage) (json.RawMessage, error)

func (f fixtureTester) RunModelTest(ctx context.Context, owner int64, body json.RawMessage) (json.RawMessage, error) {
	return f(ctx, owner, body)
}

func TestConfiguredModelWireRejectsMalformedOptionalFields(t *testing.T) {
	for _, protocol := range []string{"anthropic-messages", "openai-responses", "openai-chat", "evaluation"} {
		model := json.RawMessage(`{"id":"writer","protocol":"` + protocol + `","modelId":"vendor/model-1.2","credential":"TEST_KEY","baseUrl":"https://models.test","path":"/v1/generate","builtin":false}`)
		if !validModelTestRecord(model) {
			t.Fatalf("valid %s model rejected", protocol)
		}
	}
	base := `{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"`
	for _, tc := range []struct {
		name  string
		model string
	}{
		{"trailing JSON", base + `} {}`},
		{"unknown field", base + `,"secret":"leak"}`},
		{"reserved id", `{"id":"default","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}`},
		{"blank base URL", base + `,"baseUrl":""}`},
		{"whitespace base URL", base + `,"baseUrl":"https://models.test/a b"}`},
		{"blank path", base + `,"path":""}`},
		{"whitespace path", base + `,"path":"/v1/generate\n"}`},
		{"base URL too long", base + `,"baseUrl":"` + strings.Repeat("a", 513) + `"}`},
		{"path too long", base + `,"path":"` + strings.Repeat("a", 257) + `"}`},
		{"null base URL", base + `,"baseUrl":null}`},
		{"null path", base + `,"path":null}`},
		{"null builtin", base + `,"builtin":null}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if validModelTestRecord(json.RawMessage(tc.model)) {
				t.Fatalf("malformed configured model accepted: %s", tc.name)
			}
		})
	}
}

func TestOwnerModelTestRequestAndResult(t *testing.T) {
	const requestBody = `{"model":{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY","baseUrl":"http://127.0.0.1:3000"},"input":{"kind":"generation","system":"","prompt":"Hello","maxTokens":64}}`
	wanted := json.RawMessage(`{"ok":true,"latencyMs":12,"sample":"pong","output":{"kind":"generation","text":"pong"}}`)
	called := false
	models := OwnerModels{Tester: fixtureTester(func(_ context.Context, owner int64, body json.RawMessage) (json.RawMessage, error) {
		called = true
		require.EqualValues(t, 42, owner)
		require.JSONEq(t, requestBody, string(body))
		return wanted, nil
	})}
	request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(requestBody))
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 42}}))
	response := httptest.NewRecorder()
	models.Test(response, request)
	require.True(t, called)
	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, string(wanted), response.Body.String())

	for _, body := range []string{`{}`, `{"model":null}`, `{"model":{},"secret":"key"}`} {
		response := httptest.NewRecorder()
		models.Test(response, httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(body)).WithContext(request.Context()))
		require.Equal(t, http.StatusBadRequest, response.Code)
	}
	response = httptest.NewRecorder()
	models.Test(response, httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(requestBody)))
	require.Equal(t, http.StatusUnauthorized, response.Code)
}

func TestOwnerModelTestRejectsMalformedModelBeforeTester(t *testing.T) {
	calls := 0
	models := OwnerModels{Tester: fixtureTester(func(context.Context, int64, json.RawMessage) (json.RawMessage, error) {
		calls++
		return nil, nil
	})}
	for _, model := range []string{
		`{}`,
		`{"id":"writer","protocol":"unknown","modelId":"fixture","credential":"TEST_KEY"}`,
		`{"id":"default","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}`,
		`{"id":"writer","protocol":"openai-chat","modelId":"bad id","credential":"TEST_KEY"}`,
		`{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"bad_key"}`,
		`{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY","baseUrl":null}`,
		`{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY","secret":"key"}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(`{"model":`+model+`}`))
		request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 42}}))
		response := httptest.NewRecorder()
		models.Test(response, request)
		require.Equal(t, http.StatusBadRequest, response.Code, model)
		require.JSONEq(t, `{"code":"request_invalid"}`, response.Body.String())
	}
	require.Zero(t, calls)
}

func TestOwnerModelTestMissingCredentialIsTyped(t *testing.T) {
	models := OwnerModels{Tester: fixtureTester(func(context.Context, int64, json.RawMessage) (json.RawMessage, error) {
		return nil, ports.ErrModelCredentialMissing
	})}
	request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(`{"model":{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"MISSING_KEY"}}`))
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 42}}))
	response := httptest.NewRecorder()
	models.Test(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, `{"ok":false,"latencyMs":0,"failure":{"code":"credential_missing","credential":"MISSING_KEY"},"fault":"user"}`, response.Body.String())
}

func TestPrivateModelProbeForwardsOnlyAuthenticatedOwnerRequest(t *testing.T) {
	const body = `{"model":{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}}`
	private := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/model/test", r.URL.Path)
		require.Equal(t, "Bearer private-token", r.Header.Get("Authorization"))
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		_, _ = w.Write([]byte(`{"ok":false,"latencyMs":9,"failure":{"code":"refused","status":429},"fault":"wait"}`))
	}))
	defer private.Close()
	lease := &testLease{origin: private.URL}
	host, err := New(ResolverFunc(func(_ context.Context, owner, repository int64, request json.RawMessage) (Binding, error) {
		require.EqualValues(t, 42, owner)
		require.Zero(t, repository)
		require.JSONEq(t, body, string(request))
		return Binding{Model: json.RawMessage(`{"protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}`), CredentialName: "TEST_KEY", CredentialValue: "private-key"}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	result, err := host.RunModelTest(context.Background(), 42, json.RawMessage(body))
	require.NoError(t, err)
	require.JSONEq(t, `{"ok":false,"latencyMs":9,"failure":{"code":"refused","status":429},"fault":"wait"}`, string(result))
	require.True(t, lease.closed)
}

func TestPrivateModelProbeUsesFreshClientWhenLeaseHasNoClient(t *testing.T) {
	private := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/v1/model/test", r.URL.Path)
		assert.Equal(t, "Bearer private-token", r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer private.Close()
	lease := &testLease{origin: private.URL}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: nilClientLease{lease}})
	require.NoError(t, err)
	result, err := host.RunModelTest(context.Background(), 42, json.RawMessage(`{"model":{}}`))
	require.NoError(t, err)
	require.JSONEq(t, `{"ok":true}`, string(result))
	require.True(t, lease.closed)
}

func TestPrivateModelProbeRejectsBeforeLaunchingAHost(t *testing.T) {
	called := false
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		t.Fatal("resolver called for invalid probe")
		return Binding{}, nil
	}), testLauncher{called: &called})
	require.NoError(t, err)
	for _, tc := range []struct {
		owner int64
		body  json.RawMessage
	}{
		{0, json.RawMessage(`{"model":{}}`)},
		{42, json.RawMessage(`{`)},
	} {
		result, err := host.RunModelTest(context.Background(), tc.owner, tc.body)
		require.Nil(t, result)
		require.ErrorIs(t, err, ErrModelTestInvalid)
	}
	require.False(t, called)

	resolveErr := errors.New("resolver unavailable")
	host, err = New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, resolveErr
	}), testLauncher{called: &called})
	require.NoError(t, err)
	_, err = host.RunModelTest(context.Background(), 42, json.RawMessage(`{"model":{}}`))
	require.ErrorIs(t, err, resolveErr)
	require.False(t, called)

	launchErr := errors.New("launcher unavailable")
	host, err = New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{called: &called, err: launchErr})
	require.NoError(t, err)
	_, err = host.RunModelTest(context.Background(), 42, json.RawMessage(`{"model":{}}`))
	require.ErrorIs(t, err, launchErr)
	require.True(t, called)
}

func TestPrivateModelProbeClassifiesPrivateResponsesAndClosesBodies(t *testing.T) {
	readErr := errors.New("body read failed")
	for _, tc := range []struct {
		name    string
		status  int
		body    io.ReadCloser
		want    error
		message string
	}{
		{"bad request", http.StatusBadRequest, io.NopCloser(strings.NewReader("bad input")), ErrModelTestInvalid, ""},
		{"service unavailable", http.StatusServiceUnavailable, io.NopCloser(strings.NewReader("offline")), nil, "private model test refused"},
		{"oversized success", http.StatusOK, io.NopCloser(strings.NewReader(strings.Repeat("x", (64<<10)+1))), nil, "response too large"},
		{"read failure", http.StatusOK, &failingBody{err: readErr}, readErr, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			closed := false
			body := &trackingReadCloser{Reader: tc.body, closed: &closed}
			lease := &testLease{origin: "https://private.test", client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tc.status, Body: body, Header: make(http.Header)}, nil
			})}}
			host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
				return Binding{}, nil
			}), testLauncher{lease: lease})
			require.NoError(t, err)
			result, err := host.RunModelTest(context.Background(), 42, json.RawMessage(`{"model":{}}`))
			require.Nil(t, result)
			if tc.want != nil {
				require.ErrorIs(t, err, tc.want)
			} else {
				require.ErrorContains(t, err, tc.message)
			}
			require.True(t, closed)
			require.True(t, lease.closed)
		})
	}
}

func TestOwnerModelTestComposesThroughPrivateHost(t *testing.T) {
	const body = `{"model":{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"},"input":{"kind":"generation","system":"","prompt":"ping","maxTokens":64}}`
	private := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer private-token", r.Header.Get("Authorization"))
		require.Equal(t, "/v1/model/test", r.URL.Path)
		var request json.RawMessage
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		require.JSONEq(t, body, string(request))
		_, _ = w.Write([]byte(`{"ok":true,"latencyMs":7,"sample":"pong","output":{"kind":"generation","text":"pong"}}`))
	}))
	defer private.Close()
	lease := &testLease{origin: private.URL}
	host, err := New(ResolverFunc(func(_ context.Context, owner, repository int64, request json.RawMessage) (Binding, error) {
		require.EqualValues(t, 42, owner)
		require.Zero(t, repository)
		require.JSONEq(t, body, string(request))
		return Binding{Model: json.RawMessage(`{"protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}`), CredentialName: "TEST_KEY", CredentialValue: "secret"}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	models := OwnerModels{Tester: host}
	request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(body))
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 42}}))
	response := httptest.NewRecorder()
	models.Test(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, `{"ok":true,"latencyMs":7,"sample":"pong","output":{"kind":"generation","text":"pong"}}`, response.Body.String())
	require.True(t, lease.closed)
}

func TestPrivateModelProbeCancelsAndCleansLease(t *testing.T) {
	arrived := make(chan struct{})
	release := make(chan struct{})
	private := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(arrived)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer private.Close()
	defer close(release)
	lease := &testLease{origin: private.URL}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := host.RunModelTest(ctx, 42, json.RawMessage(`{"model":{}}`)); done <- err }()
	select {
	case <-arrived:
	case <-time.After(time.Second):
		t.Fatal("private host was not called")
	}
	cancel()
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(time.Second):
		t.Fatal("cancelled probe did not stop")
	}
	require.True(t, lease.closed)
}
