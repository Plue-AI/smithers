package errors

import (
	"encoding/json"
	stderrors "errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNotFound(t *testing.T) {
	err := NotFound("user not found")
	assert.Equal(t, http.StatusNotFound, err.Status)
	assert.Equal(t, "user not found", err.Message)
	assert.Nil(t, err.Errors)
}

func TestBadRequest(t *testing.T) {
	err := BadRequest("invalid input")
	assert.Equal(t, http.StatusBadRequest, err.Status)
	assert.Equal(t, "invalid input", err.Message)
}

func TestUnauthorized(t *testing.T) {
	err := Unauthorized("not authenticated")
	assert.Equal(t, http.StatusUnauthorized, err.Status)
	assert.Equal(t, "not authenticated", err.Message)
}

func TestForbidden(t *testing.T) {
	err := Forbidden("access denied")
	assert.Equal(t, http.StatusForbidden, err.Status)
	assert.Equal(t, "access denied", err.Message)
}

func TestConflict(t *testing.T) {
	err := Conflict("already exists")
	assert.Equal(t, http.StatusConflict, err.Status)
	assert.Equal(t, "already exists", err.Message)
}

func TestInternal(t *testing.T) {
	err := Internal("server error")
	assert.Equal(t, http.StatusInternalServerError, err.Status)
	assert.Equal(t, "server error", err.Message)
}

func TestUnsupportedMediaType(t *testing.T) {
	err := UnsupportedMediaType("unsupported content type")
	assert.Equal(t, http.StatusUnsupportedMediaType, err.Status)
	assert.Equal(t, "unsupported content type", err.Message)
}

func TestGatewayTimeout(t *testing.T) {
	err := GatewayTimeout("request timeout")
	assert.Equal(t, http.StatusGatewayTimeout, err.Status)
	assert.Equal(t, "request timeout", err.Message)
}

func TestRequestEntityTooLarge(t *testing.T) {
	err := RequestEntityTooLarge("request body too large")
	assert.Equal(t, http.StatusRequestEntityTooLarge, err.Status)
	assert.Equal(t, "request body too large", err.Message)
	assert.Nil(t, err.Errors)
}

func TestQuotaExceeded(t *testing.T) {
	err := QuotaExceeded("sandbox limit reached")
	assert.Equal(t, http.StatusTooManyRequests, err.Status)
	assert.Equal(t, "sandbox limit reached", err.Message)
	assert.Equal(t, CodeQuotaExceeded, err.Code)
}

func TestNoCapacity(t *testing.T) {
	err := NoCapacity("The workspace pool is full right now.")
	assert.Equal(t, http.StatusServiceUnavailable, err.Status)
	assert.Equal(t, "The workspace pool is full right now.", err.Message)
	assert.Equal(t, CodeNoCapacity, err.Code)
	assert.Equal(t, 30, err.RetryAfter, "a full pool is retryable and the client needs a delay")

	data, marshalErr := json.Marshal(err)
	require.NoError(t, marshalErr)
	var body struct {
		Message    string `json:"message"`
		Code       string `json:"code"`
		RetryAfter int    `json:"retry_after"`
	}
	require.NoError(t, json.Unmarshal(data, &body))
	assert.Equal(t, "no_capacity", body.Code)
	// UPDATED DELIBERATELY: retry_after used to be header-only. The Worker in
	// front of plue does not forward upstream headers, so the pacing a client
	// actually receives is the one in the body.
	assert.Equal(t, 30, body.RetryAfter, "the client reads the pacing out of the body")
}

func TestQuotaExceeded_CodeSerializesToJSON(t *testing.T) {
	err := QuotaExceeded("hit the cap")
	data, marshalErr := json.Marshal(err)
	require.NoError(t, marshalErr)

	var body struct {
		Message string `json:"message"`
		Code    string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(data, &body))
	assert.Equal(t, "hit the cap", body.Message)
	assert.Equal(t, "quota_exceeded", body.Code)
}

func TestAPIError_CodeIsAlwaysPresent(t *testing.T) {
	// INVERTED DELIBERATELY. This test used to assert the opposite: that a
	// code-less constructor left `code` out of the body, because a structured
	// code was opt-in. It is not opt-in any more. A client that has to guess
	// from the status and the English sentence guesses wrong — which is how a
	// full pool reached people as an internal 500 — so every constructor now
	// names a registered code and a fault.
	err := NotFound("missing")
	data, marshalErr := json.Marshal(err)
	require.NoError(t, marshalErr)

	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(data, &raw))
	assert.JSONEq(t, `"not_found"`, string(raw["code"]))
	assert.JSONEq(t, `"user"`, string(raw["fault"]))
}

func TestValidationFailed(t *testing.T) {
	err := ValidationFailed(
		FieldError{Resource: "Repository", Field: "name", Code: "missing_field"},
		FieldError{Resource: "Repository", Field: "description", Code: "invalid"},
	)
	assert.Equal(t, http.StatusUnprocessableEntity, err.Status)
	assert.Equal(t, "validation failed", err.Message)
	require.Len(t, err.Errors, 2)
	assert.Equal(t, "Repository", err.Errors[0].Resource)
	assert.Equal(t, "name", err.Errors[0].Field)
	assert.Equal(t, "missing_field", err.Errors[0].Code)
}

func TestAPIError_Error(t *testing.T) {
	err := NotFound("test")
	assert.Equal(t, "test", err.Error())
}

func TestWriteError(t *testing.T) {
	w := httptest.NewRecorder()
	WriteError(w, ValidationFailed(FieldError{Resource: "Repo", Field: "name", Code: "missing_field"}))

	assert.Equal(t, http.StatusUnprocessableEntity, w.Code)
	assert.Equal(t, "application/json", w.Header().Get("Content-Type"))

	var body APIError
	require.NoError(t, json.NewDecoder(w.Body).Decode(&body))
	assert.Equal(t, "validation failed", body.Message)
	require.Len(t, body.Errors, 1)
	assert.Equal(t, "name", body.Errors[0].Field)
}

func TestWriteJSON(t *testing.T) {
	w := httptest.NewRecorder()
	WriteJSON(w, http.StatusCreated, map[string]string{"id": "1"})

	assert.Equal(t, http.StatusCreated, w.Code)
	assert.Equal(t, "application/json", w.Header().Get("Content-Type"))

	var body map[string]string
	require.NoError(t, json.NewDecoder(w.Body).Decode(&body))
	assert.Equal(t, "1", body["id"])
}

func TestAPIError_StatusOmittedFromJSON(t *testing.T) {
	err := NotFound("resource not found")
	data, marshalErr := json.Marshal(err)
	require.NoError(t, marshalErr)

	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(data, &raw))

	_, hasStatus := raw["status"]
	assert.False(t, hasStatus, "status field must be excluded from JSON via json:\"-\" tag")
	assert.Contains(t, string(data), `"message":"resource not found"`)
}

func TestAPIError_ErrorsOmittedWhenEmpty(t *testing.T) {
	err := BadRequest("bad input")
	data, marshalErr := json.Marshal(err)
	require.NoError(t, marshalErr)

	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(data, &raw))

	_, hasErrors := raw["errors"]
	assert.False(t, hasErrors, "errors field must be omitted from JSON when empty via omitempty tag")
}

func TestWriteError_IncludesCodeWhenPresent(t *testing.T) {
	w := httptest.NewRecorder()
	WriteError(w, &APIError{
		Status:  http.StatusForbidden,
		Code:    "FORBIDDEN_ACTION",
		Message: "This action is not allowed",
	})

	var body map[string]any
	require.NoError(t, json.NewDecoder(w.Body).Decode(&body))
	assert.Equal(t, "FORBIDDEN_ACTION", body["code"])
	assert.Equal(t, "This action is not allowed", body["message"])
}

func TestWriteError_IncludesStructuredGitHubRateLimit(t *testing.T) {
	limit := 5000
	remaining := 0
	resetAt := time.Date(2026, 9, 2, 13, 0, 0, 0, time.UTC)
	w := httptest.NewRecorder()
	WriteError(w, &APIError{
		Status:    http.StatusTooManyRequests,
		Code:      CodeGitHubRateLimited,
		Message:   "github installation rate limit exceeded",
		Limit:     &limit,
		Remaining: &remaining,
		ResetAt:   &resetAt,
	})

	assert.Equal(t, http.StatusTooManyRequests, w.Code)
	assert.JSONEq(t, `{
		"code":"github_rate_limited",
		"fault":"dependency",
		"message":"github installation rate limit exceeded",
		"limit":5000,
		"remaining":0,
		"reset_at":"2026-09-02T13:00:00Z"
	}`, w.Body.String())
}

func TestAPIError_ImplementsErrorInterface(t *testing.T) {
	var err error = NotFound("test")
	assert.EqualError(t, err, "test")
}

func TestValidationFailed_NoFieldErrors(t *testing.T) {
	err := ValidationFailed()
	assert.Equal(t, http.StatusUnprocessableEntity, err.Status)
	assert.Equal(t, "validation failed", err.Message)
	assert.Empty(t, err.Errors)
}

func TestWriteError_SetsCorrectStatusForEachErrorType(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		err        *APIError
		wantStatus int
		wantMsg    string
	}{
		{"not found", NotFound("missing"), http.StatusNotFound, "missing"},
		{"bad request", BadRequest("bad"), http.StatusBadRequest, "bad"},
		{"unauthorized", Unauthorized("denied"), http.StatusUnauthorized, "denied"},
		{"forbidden", Forbidden("nope"), http.StatusForbidden, "nope"},
		{"conflict", Conflict("dup"), http.StatusConflict, "dup"},
		{"internal", Internal("oops"), http.StatusInternalServerError, "oops"},
		{"unsupported media type", UnsupportedMediaType("wrong type"), http.StatusUnsupportedMediaType, "wrong type"},
		{"gateway timeout", GatewayTimeout("slow"), http.StatusGatewayTimeout, "slow"},
		{"request entity too large", RequestEntityTooLarge("too big"), http.StatusRequestEntityTooLarge, "too big"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			w := httptest.NewRecorder()
			WriteError(w, tc.err)

			assert.Equal(t, tc.wantStatus, w.Code)
			assert.Equal(t, "application/json", w.Header().Get("Content-Type"))

			var body APIError
			require.NoError(t, json.NewDecoder(w.Body).Decode(&body))
			assert.Equal(t, tc.wantMsg, body.Message)
		})
	}
}

func TestWriteError_WithFieldErrors(t *testing.T) {
	w := httptest.NewRecorder()
	err := ValidationFailed(
		FieldError{Resource: "User", Field: "email", Code: "invalid"},
		FieldError{Resource: "User", Field: "username", Code: "already_exists"},
	)
	WriteError(w, err)

	assert.Equal(t, http.StatusUnprocessableEntity, w.Code)

	var body struct {
		Message string       `json:"message"`
		Errors  []FieldError `json:"errors"`
	}
	require.NoError(t, json.NewDecoder(w.Body).Decode(&body))
	require.Len(t, body.Errors, 2)

	assert.Equal(t, "email", body.Errors[0].Field)
	assert.Equal(t, "invalid", body.Errors[0].Code)
	assert.Equal(t, "username", body.Errors[1].Field)
	assert.Equal(t, "already_exists", body.Errors[1].Code)
}

func TestWithCauseKeepsTheCauseOffTheWire(t *testing.T) {
	cause := stderrors.New("ERROR: canceling statement due to statement timeout (SQLSTATE 57014)")
	err := Internal("failed to set secret")

	got := err.WithCause(cause)

	assert.Same(t, err, got, "WithCause returns the receiver so it chains at the return site")
	assert.Equal(t, cause, got.Cause())
	assert.Equal(t, "failed to set secret", got.Error(), "Error() stays the human sentence")

	rec := httptest.NewRecorder()
	WriteError(rec, got)
	assert.NotContains(t, rec.Body.String(), "SQLSTATE")
	assert.Contains(t, rec.Body.String(), "failed to set secret")
}

func TestWithCauseNilKeepsAnEarlierCause(t *testing.T) {
	cause := stderrors.New("first")
	err := Internal("boom").WithCause(cause).WithCause(nil)
	assert.Equal(t, cause, err.Cause())
	assert.Nil(t, Internal("boom").Cause())
}

// TestRefusalsCarryPermissionClass pins §5.2.1: a 401 or 403 answers in the
// §6.2.3 envelope with class permission. The app reads a missing class as
// infra ("not your fault"), so a classless forbidden tells a refused caller
// that plue broke.
func TestRefusalsCarryPermissionClass(t *testing.T) {
	for name, err := range map[string]*APIError{
		"forbidden from the registry":     Forbidden("credential does not belong to the installation owner"),
		"unauthorized from the registry":  Unauthorized("sign in"),
		"bare 403 composite":              {Status: http.StatusForbidden, Message: "denied"},
		"bare 401 composite":              {Status: http.StatusUnauthorized, Message: "sign in"},
		"composite with a code, no class": {Status: http.StatusForbidden, Code: CodeOrgMembershipRequired, Fault: FaultUser, Message: "join"},
	} {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			WriteError(rec, err)
			var body map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, "permission", body["class"])
		})
	}
}

func TestExplicitClassSurvivesTheWire(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, &APIError{Status: http.StatusForbidden, Code: CodeForbidden, Class: ClassNever, Message: "Only a person can do this"})
	assert.Contains(t, rec.Body.String(), `"class":"never"`)
}
