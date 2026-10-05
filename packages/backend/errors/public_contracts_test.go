package errors_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	stderrors "errors"
	"net/http/httptest"
	"testing"

	apierrors "github.com/smithersai/smithers/packages/backend/errors"
	"github.com/stretchr/testify/require"
)

func TestPublicErrorConstructorsCarryLiteralWireVerdicts(t *testing.T) {
	for _, row := range []struct {
		name        string
		build       func(string) *apierrors.APIError
		code, fault string
		status      int
	}{
		{"bad request", apierrors.BadRequest, "bad_request", "user", 400},
		{"unauthorized", apierrors.Unauthorized, "unauthorized", "user", 401},
		{"forbidden", apierrors.Forbidden, "forbidden", "user", 403},
		{"not found", apierrors.NotFound, "not_found", "user", 404},
		{"conflict", apierrors.Conflict, "conflict", "user", 409},
		{"body size", apierrors.RequestEntityTooLarge, "request_entity_too_large", "user", 413},
		{"internal", apierrors.Internal, "internal", "bug", 500},
	} {
		t.Run(row.name, func(t *testing.T) {
			err := row.build("action refused")
			require.Equal(t, row.status, err.Status)
			require.Equal(t, row.code, string(err.Code))
			require.Equal(t, row.fault, string(err.Fault))
			require.Zero(t, err.RetryAfter)
			recorder := httptest.NewRecorder()
			apierrors.WriteError(recorder, err)
			require.Equal(t, row.status, recorder.Code)
			require.Equal(t, "application/json", recorder.Header().Get("Content-Type"))
			class := ""
			if row.status == 401 || row.status == 403 {
				class = `"class":"permission",`
			}
			require.JSONEq(t, `{"code":"`+row.code+`",`+class+`"fault":"`+row.fault+`","message":"action refused"}`, recorder.Body.String())
		})
	}
	for _, row := range []struct {
		code   apierrors.Code
		status int
		fault  string
	}{
		{apierrors.CodeServiceUnavailable, 503, "infra"},
		{apierrors.CodePreviewUnavailable, 503, "infra"},
		{apierrors.CodeHostLeaseLost, 503, "infra"},
		{apierrors.CodeConflict, 409, "user"},
		{apierrors.CodeNotFound, 404, "user"},
	} {
		err := apierrors.New(row.code, "action refused")
		require.Equal(t, row.status, err.Status)
		require.Equal(t, row.fault, string(err.Fault))
		require.Equal(t, row.code, err.Code)
	}
	require.Equal(t, "infra", string(apierrors.FaultInfra))
	require.Equal(t, "user", string(apierrors.FaultUser))
}

func TestPublicErrorsValidationCauseAndRetryDoNotMutateCaller(t *testing.T) {
	validation := apierrors.ValidationFailed(apierrors.FieldError{Resource: "Repo", Field: "name", Code: "missing"})
	recorder := httptest.NewRecorder()
	apierrors.WriteError(recorder, validation)
	require.Equal(t, 422, recorder.Code)
	require.JSONEq(t, `{"code":"validation_failed","fault":"user","message":"validation failed","errors":[{"resource":"Repo","field":"name","code":"missing"}]}`, recorder.Body.String())
	cause := stderrors.New("unit-only private storage diagnostic")
	internal := apierrors.Internal("internal server error")
	require.Same(t, internal, internal.WithCause(cause))
	require.Same(t, cause, internal.Cause())
	require.Same(t, cause, internal.WithCause(nil).Cause())
	require.False(t, stderrors.Is(internal, cause), "public APIError causes are log metadata, not implicit unwrapping")
	recorder = httptest.NewRecorder()
	apierrors.WriteError(recorder, internal)
	require.NotContains(t, recorder.Body.String(), cause.Error())
	require.JSONEq(t, `{"code":"internal","fault":"bug","message":"internal server error"}`, recorder.Body.String())
	for _, row := range []struct {
		retry                int
		existing, wantHeader string
	}{
		{0, "", "0"}, {7, "", "7"}, {7, "31", "31"},
	} {
		err := &apierrors.APIError{Status: 429, Message: "slow down", RetryAfter: row.retry}
		recorder := httptest.NewRecorder()
		if row.existing != "" {
			recorder.Header().Set("Retry-After", row.existing)
		}
		apierrors.WriteError(recorder, err)
		require.Equal(t, row.wantHeader, recorder.Header().Get("Retry-After"))
		require.Empty(t, err.Code)
		require.Empty(t, err.Fault)
		var body struct {
			Code, Fault, Message string
			Retry                int `json:"retry_after"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, "rate_limit_exceeded", body.Code)
		require.Equal(t, "user", body.Fault)
		require.Equal(t, row.retry, body.Retry)
	}
	jsonResponse := httptest.NewRecorder()
	apierrors.WriteJSON(jsonResponse, 201, map[string]any{"id": 7, "label": "héllo", "active": true})
	require.Equal(t, 201, jsonResponse.Code)
	require.Equal(t, "application/json", jsonResponse.Header().Get("Content-Type"))
	require.JSONEq(t, `{"id":7,"label":"héllo","active":true}`, jsonResponse.Body.String())
}

func TestPublicFailureDocumentIsSortedAndSelfVerifying(t *testing.T) {
	raw, err := apierrors.MarshalDocument()
	require.NoError(t, err)
	var document struct {
		Schema int             `json:"schema_version"`
		Digest string          `json:"digest"`
		Faults []string        `json:"faults"`
		Codes  json.RawMessage `json:"codes"`
	}
	require.NoError(t, json.Unmarshal(raw, &document))
	require.Equal(t, 1, document.Schema)
	require.Equal(t, []string{"user", "wait", "infra", "dependency", "bug", "factory", "policy"}, document.Faults)
	var compact bytes.Buffer
	require.NoError(t, json.Compact(&compact, document.Codes))
	digest := sha256.Sum256(compact.Bytes())
	require.Equal(t, "sha256:"+hex.EncodeToString(digest[:]), document.Digest)
	var codes []struct {
		Code, Fault string
		Status      int
		Doc         string
	}
	require.NoError(t, json.Unmarshal(document.Codes, &codes))
	require.NotEmpty(t, codes)
	seen := map[string]int{}
	for i, code := range codes {
		if i > 0 {
			require.Less(t, codes[i-1].Code, code.Code, "strict order also excludes duplicate verdicts")
		}
		require.NotEmpty(t, code.Doc)
		seen[code.Code] = code.Status
	}
	require.Equal(t, 400, seen["bad_request"])
	require.Equal(t, 500, seen["internal"])
	require.Equal(t, 503, seen["host_lease_lost"])
}
