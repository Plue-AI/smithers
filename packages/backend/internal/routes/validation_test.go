package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// --- validateSecretVariableName unit tests ---

func TestValidateSecretVariableName_Valid(t *testing.T) {
	t.Parallel()

	valid := []string{
		"MY_SECRET",
		"_private",
		"a",
		"ABC123",
		"_",
		"a1_b2_c3",
		"SMITHERS_TOKEN",
		strings.Repeat("A", 255),
	}

	for _, name := range valid {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			apiErr := validateSecretVariableName(name, "Secret")
			assert.Nil(t, apiErr, "expected name %q to be valid", name)
		})
	}
}

func TestValidateSecretVariableName_Invalid(t *testing.T) {
	t.Parallel()

	cases := []struct {
		label    string
		input    string
		wantCode string
	}{
		{"empty", "", "missing_field"},
		{"whitespace_only", "   ", "missing_field"},
		{"starts_with_digit", "123abc", "invalid"},
		{"contains_space", "my secret", "invalid"},
		{"contains_dash", "my-secret", "invalid"},
		{"contains_dot", "my.secret", "invalid"},
		{"contains_dollar", "$HOME", "invalid"},
		{"contains_equals", "name=value", "invalid"},
		{"contains_null_byte", "name\x00", "invalid"},
		{"contains_newline", "name\n", "invalid"},
		{"contains_tab", "name\t", "invalid"},
		{"over_max_length", strings.Repeat("A", 256), "invalid"},
		{"unicode", "caf\u00e9", "invalid"},
		{"sql_injection", "'; DROP TABLE--", "invalid"},
		{"path_traversal", "../../../etc/passwd", "invalid"},
		{"html_injection", "<script>alert(1)</script>", "invalid"},
		{"backslash", "name\\value", "invalid"},
		{"slash", "name/value", "invalid"},
		{"zero_width_space", "\u200bname", "invalid"},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			t.Parallel()
			apiErr := validateSecretVariableName(tc.input, "Secret")
			require.NotNil(t, apiErr, "expected name %q to be rejected", tc.input)
			assert.Equal(t, http.StatusUnprocessableEntity, apiErr.Status)
			assert.Equal(t, "validation failed", apiErr.Message)
			require.Len(t, apiErr.Errors, 1)
			assert.Equal(t, "Secret", apiErr.Errors[0].Resource)
			assert.Equal(t, "name", apiErr.Errors[0].Field)
			assert.Equal(t, tc.wantCode, apiErr.Errors[0].Code)
		})
	}
}

// --- validateSecretVariableValue unit tests ---

func TestValidateSecretVariableValue_Valid(t *testing.T) {
	t.Parallel()

	cases := []struct {
		label string
		value string
	}{
		{"simple", "hello"},
		{"single_char", "a"},
		{"at_max_size", strings.Repeat("x", 64*1024)},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			t.Parallel()
			apiErr := validateSecretVariableValue(tc.value, "Secret")
			assert.Nil(t, apiErr)
		})
	}
}

func TestValidateSecretVariableValue_Invalid(t *testing.T) {
	t.Parallel()

	cases := []struct {
		label    string
		input    string
		wantCode string
	}{
		{"empty", "", "missing_field"},
		{"over_max_size", strings.Repeat("x", 64*1024+1), "invalid"},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			t.Parallel()
			apiErr := validateSecretVariableValue(tc.input, "Secret")
			require.NotNil(t, apiErr)
			assert.Equal(t, http.StatusUnprocessableEntity, apiErr.Status)
			require.Len(t, apiErr.Errors, 1)
			assert.Equal(t, "value", apiErr.Errors[0].Field)
			assert.Equal(t, tc.wantCode, apiErr.Errors[0].Code)
		})
	}
}

// --- Fuzz tests ---

func FuzzValidateSecretVariableName(f *testing.F) {
	f.Add("MY_SECRET")
	f.Add("_private")
	f.Add("a")
	f.Add("")
	f.Add("123abc")
	f.Add("my secret")
	f.Add("my-secret")
	f.Add("$HOME")
	f.Add("name\x00")
	f.Add(strings.Repeat("A", 256))
	f.Add("caf\u00e9")
	f.Add("'; DROP TABLE--")
	f.Add("\u200bname")

	f.Fuzz(func(t *testing.T, name string) {
		// Must never panic.
		_ = validateSecretVariableName(name, "Secret")
	})
}

func FuzzValidateSecretVariableValue(f *testing.F) {
	f.Add("hello")
	f.Add("")
	f.Add(strings.Repeat("x", 64*1024))
	f.Add(strings.Repeat("x", 64*1024+1))

	f.Fuzz(func(t *testing.T, value string) {
		// Must never panic.
		_ = validateSecretVariableValue(value, "Secret")
	})
}

// --- Route-level integration tests ---

// mockSecretService is a mock for SecretRouteService used in route tests.
type mockSecretService struct {
	setSecretFn    func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.SecretResponse, error)
	listSecretsFn  func(ctx context.Context, actor *db.User, owner, repo string) ([]services.SecretResponse, error)
	deleteSecretFn func(ctx context.Context, actor *db.User, owner, repo, name string) error
}

func (m *mockSecretService) UpdateSecret(_ context.Context, _ *db.User, _, _, name string, mainOnly *bool, _ *services.SecretBinding) (services.SecretResponse, error) {
	return services.SecretResponse{Name: name, MainOnly: mainOnly != nil && *mainOnly}, nil
}

func (m *mockSecretService) SetSecret(ctx context.Context, actor *db.User, owner, repo, name, value string, _ *bool, _ *services.SecretBinding) (services.SecretResponse, error) {
	if m.setSecretFn != nil {
		return m.setSecretFn(ctx, actor, owner, repo, name, value)
	}
	return services.SecretResponse{Name: name, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"}, nil
}

func (m *mockSecretService) ListSecrets(ctx context.Context, actor *db.User, owner, repo string) ([]services.SecretResponse, error) {
	if m.listSecretsFn != nil {
		return m.listSecretsFn(ctx, actor, owner, repo)
	}
	return nil, nil
}

func (m *mockSecretService) DeleteSecret(ctx context.Context, actor *db.User, owner, repo, name string) error {
	if m.deleteSecretFn != nil {
		return m.deleteSecretFn(ctx, actor, owner, repo, name)
	}
	return nil
}

func (m *mockSecretService) SetOrgSecret(ctx context.Context, actor *db.User, orgName, name, value string, _ *services.SecretBinding) (services.SecretResponse, error) {
	return services.SecretResponse{Name: name, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"}, nil
}

func (m *mockSecretService) ListOrgSecrets(ctx context.Context, actor *db.User, orgName string) ([]services.SecretResponse, error) {
	return nil, nil
}

func (m *mockSecretService) DeleteOrgSecret(ctx context.Context, actor *db.User, orgName, name string) error {
	return nil
}

// mockVariableService is a mock for VariableRouteService used in route tests.
type mockVariableService struct {
	setVariableFn    func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error)
	getVariableFn    func(ctx context.Context, actor *db.User, owner, repo, name string) (services.VariableResponse, error)
	listVariablesFn  func(ctx context.Context, actor *db.User, owner, repo string) ([]services.VariableResponse, error)
	deleteVariableFn func(ctx context.Context, actor *db.User, owner, repo, name string) error
}

func (m *mockVariableService) SetVariable(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error) {
	if m.setVariableFn != nil {
		return m.setVariableFn(ctx, actor, owner, repo, name, value)
	}
	return services.VariableResponse{Name: name, Value: value, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"}, nil
}

func (m *mockVariableService) GetVariable(ctx context.Context, actor *db.User, owner, repo, name string) (services.VariableResponse, error) {
	if m.getVariableFn != nil {
		return m.getVariableFn(ctx, actor, owner, repo, name)
	}
	return services.VariableResponse{}, nil
}

func (m *mockVariableService) ListVariables(ctx context.Context, actor *db.User, owner, repo string) ([]services.VariableResponse, error) {
	if m.listVariablesFn != nil {
		return m.listVariablesFn(ctx, actor, owner, repo)
	}
	return nil, nil
}

func (m *mockVariableService) DeleteVariable(ctx context.Context, actor *db.User, owner, repo, name string) error {
	if m.deleteVariableFn != nil {
		return m.deleteVariableFn(ctx, actor, owner, repo, name)
	}
	return nil
}

func (m *mockVariableService) SetOrgVariable(ctx context.Context, actor *db.User, orgName, name, value string) (services.VariableResponse, error) {
	return services.VariableResponse{Name: name, Value: value, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"}, nil
}

func (m *mockVariableService) ListOrgVariables(ctx context.Context, actor *db.User, orgName string) ([]services.VariableResponse, error) {
	return nil, nil
}

func (m *mockVariableService) DeleteOrgVariable(ctx context.Context, actor *db.User, orgName, name string) error {
	return nil
}

func newTestRequest(method, target string, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func withTestUser(r *http.Request, user *db.User) *http.Request {
	ctx := context.WithValue(r.Context(), middleware.UserContextKey, user)
	return r.WithContext(ctx)
}

func withChiParams(r *http.Request, params map[string]string) *http.Request {
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

var testUser = &db.User{ID: 1, Username: "testuser"}

func TestSecretHandler_SetSecret_ValidName(t *testing.T) {
	t.Parallel()

	serviceCalled := false
	handler := &SecretHandler{
		Service: &mockSecretService{
			setSecretFn: func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.SecretResponse, error) {
				serviceCalled = true
				return services.SecretResponse{Name: name, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"}, nil
			},
		},
		Metrics: NewSmithersMetrics(),
	}

	body := `{"name":"MY_SECRET","value":"secret_value"}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/secrets", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetSecret(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.True(t, serviceCalled, "service should have been called")
}

func TestSecretHandler_SetSecret_InvalidName(t *testing.T) {
	t.Parallel()

	serviceCalled := false
	handler := &SecretHandler{
		Service: &mockSecretService{
			setSecretFn: func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.SecretResponse, error) {
				serviceCalled = true
				return services.SecretResponse{}, nil
			},
		},
		Metrics: NewSmithersMetrics(),
	}

	body := `{"name":"invalid-name","value":"secret_value"}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/secrets", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetSecret(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.False(t, serviceCalled, "service should not have been called for invalid name")

	var apiErr errors.APIError
	err := json.NewDecoder(rec.Body).Decode(&apiErr)
	require.NoError(t, err)
	assert.Equal(t, "validation failed", apiErr.Message)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, "Secret", apiErr.Errors[0].Resource)
	assert.Equal(t, "name", apiErr.Errors[0].Field)
}

func TestSecretHandler_SetSecret_EmptyValue(t *testing.T) {
	t.Parallel()

	serviceCalled := false
	handler := &SecretHandler{
		Service: &mockSecretService{
			setSecretFn: func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.SecretResponse, error) {
				serviceCalled = true
				return services.SecretResponse{}, nil
			},
		},
		Metrics: NewSmithersMetrics(),
	}

	body := `{"name":"VALID_NAME","value":""}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/secrets", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetSecret(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.False(t, serviceCalled, "service should not have been called for empty value")
}

func TestVariableHandler_SetVariable_ValidName(t *testing.T) {
	t.Parallel()

	serviceCalled := false
	handler := &VariableHandler{
		Service: &mockVariableService{
			setVariableFn: func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error) {
				serviceCalled = true
				return services.VariableResponse{Name: name, Value: value, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"}, nil
			},
		},
		Metrics: NewSmithersMetrics(),
	}

	body := `{"name":"MY_VAR","value":"var_value"}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/variables", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetVariable(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.True(t, serviceCalled, "service should have been called")
}

func TestVariableHandler_SetVariable_InvalidName(t *testing.T) {
	t.Parallel()

	serviceCalled := false
	handler := &VariableHandler{
		Service: &mockVariableService{
			setVariableFn: func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error) {
				serviceCalled = true
				return services.VariableResponse{}, nil
			},
		},
		Metrics: NewSmithersMetrics(),
	}

	body := `{"name":"$INVALID","value":"var_value"}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/variables", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetVariable(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.False(t, serviceCalled, "service should not have been called for invalid name")

	var apiErr errors.APIError
	err := json.NewDecoder(rec.Body).Decode(&apiErr)
	require.NoError(t, err)
	assert.Equal(t, "validation failed", apiErr.Message)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, "Variable", apiErr.Errors[0].Resource)
	assert.Equal(t, "name", apiErr.Errors[0].Field)
}

func TestVariableHandler_SetVariable_EmptyValue(t *testing.T) {
	t.Parallel()

	serviceCalled := false
	handler := &VariableHandler{
		Service: &mockVariableService{
			setVariableFn: func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error) {
				serviceCalled = true
				return services.VariableResponse{}, nil
			},
		},
		Metrics: NewSmithersMetrics(),
	}

	body := `{"name":"VALID_NAME","value":""}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/variables", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetVariable(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.False(t, serviceCalled, "service should not have been called for empty value")
}

func TestSecretHandler_DeleteSecret_InvalidName(t *testing.T) {
	t.Parallel()

	serviceCalled := false
	handler := &SecretHandler{
		Service: &mockSecretService{
			deleteSecretFn: func(ctx context.Context, actor *db.User, owner, repo, name string) error {
				serviceCalled = true
				return nil
			},
		},
		Metrics: NewSmithersMetrics(),
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/owner/repo/secrets/invalid-name", nil)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo", "name": "invalid-name"})

	rec := httptest.NewRecorder()
	handler.DeleteSecret(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.False(t, serviceCalled, "service should not have been called for invalid name")
}

func TestVariableHandler_DeleteVariable_InvalidName(t *testing.T) {
	t.Parallel()

	serviceCalled := false
	handler := &VariableHandler{
		Service: &mockVariableService{
			deleteVariableFn: func(ctx context.Context, actor *db.User, owner, repo, name string) error {
				serviceCalled = true
				return nil
			},
		},
		Metrics: NewSmithersMetrics(),
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/owner/repo/variables/bad.name", nil)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo", "name": "bad.name"})

	rec := httptest.NewRecorder()
	handler.DeleteVariable(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.False(t, serviceCalled, "service should not have been called for invalid name")
}

func TestSecretHandler_SetSecret_NameAtMaxLength(t *testing.T) {
	t.Parallel()

	handler := &SecretHandler{
		Service: &mockSecretService{},
		Metrics: NewSmithersMetrics(),
	}

	name := strings.Repeat("A", 255)
	body := `{"name":"` + name + `","value":"v"}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/secrets", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetSecret(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
}

func TestSecretHandler_SetSecret_NameOverMaxLength(t *testing.T) {
	t.Parallel()

	handler := &SecretHandler{
		Service: &mockSecretService{},
		Metrics: NewSmithersMetrics(),
	}

	name := strings.Repeat("A", 256)
	body := `{"name":"` + name + `","value":"v"}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/secrets", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetSecret(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}

func TestSecretHandler_SetSecret_NullByteName(t *testing.T) {
	t.Parallel()

	handler := &SecretHandler{
		Service: &mockSecretService{},
		Metrics: NewSmithersMetrics(),
	}

	body := `{"name":"name\u0000","value":"v"}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/secrets", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetSecret(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}

func TestSecretHandler_SetSecret_UnicodeName(t *testing.T) {
	t.Parallel()

	handler := &SecretHandler{
		Service: &mockSecretService{},
		Metrics: NewSmithersMetrics(),
	}

	body := `{"name":"caf\u00e9","value":"v"}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/secrets", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetSecret(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}

func TestValidationMetrics_Incremented(t *testing.T) {
	t.Parallel()

	metrics := NewSmithersMetrics()
	handler := &SecretHandler{
		Service: &mockSecretService{},
		Metrics: metrics,
	}

	body := `{"name":"invalid-name","value":"v"}`
	req := newTestRequest(http.MethodPut, "/api/repos/owner/repo/secrets", body)
	req = withTestUser(req, testUser)
	req = withChiParams(req, map[string]string{"owner": "owner", "repo": "repo"})

	rec := httptest.NewRecorder()
	handler.SetSecret(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)

	// Verify the Prometheus counter was incremented.
	counter, err := metrics.ValidationRejectionsTotal().GetMetricWithLabelValues("Secret", "name")
	require.NoError(t, err)
	var metric dto.Metric
	require.NoError(t, counter.Write(&metric))
	assert.Equal(t, 1.0, metric.GetCounter().GetValue())
}
