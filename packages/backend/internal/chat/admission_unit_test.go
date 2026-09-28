package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func admissionUnitBody(t *testing.T, change func(map[string]any, map[string]any)) []byte {
	t.Helper()
	journal := map[string]any{"version": 1, "legId": "leg", "token": strings.Repeat("a", 32)}
	fields := map[string]any{"runId": "run", "journal": journal, "messages": []any{}, "instructions": "héllo"}
	if change != nil {
		change(fields, journal)
	}
	raw, err := json.Marshal(fields)
	require.NoError(t, err)
	return raw
}

func TestChatAdmissionUnitSealsRequestWithoutJournalCredential(t *testing.T) {
	raw := []byte(`{"runId":"run","messages":[],"journal":{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","legId":"leg","version":1},"instructions":"héllo"}`)
	response := httptest.NewRecorder()
	runID, journal, payload, ok := readTurnRequest(response, httptest.NewRequest("POST", TurnPath, strings.NewReader(string(raw))))
	require.True(t, ok)
	require.Equal(t, "run", runID)
	require.Equal(t, JournalRequest{Version: 1, LegID: "leg", Token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, journal)
	require.Equal(t, `{"instructions":"héllo","messages":[],"runId":"run"}`, string(payload), "sealed request has independently specified canonical bytes")
	require.NotContains(t, string(payload), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	require.NotContains(t, string(payload), "journal")
	require.Equal(t, `{"runId":"run","messages":[],"journal":{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","legId":"leg","version":1},"instructions":"héllo"}`, string(raw))
}

func TestChatAdmissionUnitRejectsMalformedJournalAndRequestFields(t *testing.T) {
	for _, item := range []struct {
		name   string
		change func(map[string]any, map[string]any)
	}{
		{"missing run", func(f, j map[string]any) { delete(f, "runId") }},
		{"numeric run", func(f, j map[string]any) { f["runId"] = 1 }},
		{"empty run", func(f, j map[string]any) { f["runId"] = "" }},
		{"journal missing", func(f, j map[string]any) { delete(f, "journal") }},
		{"journal null", func(f, j map[string]any) { f["journal"] = nil }},
		{"journal array", func(f, j map[string]any) { f["journal"] = []any{} }},
		{"journal unknown member", func(f, j map[string]any) { j["unknown"] = true }},
		{"journal token missing", func(f, j map[string]any) { delete(j, "token") }},
		{"journal unsupported version", func(f, j map[string]any) { j["version"] = 2 }},
		{"journal version string", func(f, j map[string]any) { j["version"] = "1" }},
		{"journal version noninteger spelling", func(f, j map[string]any) { j["version"] = json.RawMessage("1.0") }},
		{"journal leg type", func(f, j map[string]any) { j["legId"] = true }},
		{"journal leg empty", func(f, j map[string]any) { j["legId"] = "" }},
		{"journal token type", func(f, j map[string]any) { j["token"] = 1 }},
		{"journal token invalid alphabet", func(f, j map[string]any) { j["token"] = strings.Repeat("!", 32) }},
		{"messages missing", func(f, j map[string]any) { delete(f, "messages") }},
		{"messages null", func(f, j map[string]any) { f["messages"] = nil }},
		{"messages object", func(f, j map[string]any) { f["messages"] = map[string]any{} }},
		{"instructions missing", func(f, j map[string]any) { delete(f, "instructions") }},
		{"instructions null", func(f, j map[string]any) { f["instructions"] = nil }},
		{"instructions numeric", func(f, j map[string]any) { f["instructions"] = 1 }},
	} {
		t.Run(item.name, func(t *testing.T) {
			raw := admissionUnitBody(t, item.change)
			response := httptest.NewRecorder()
			runID, journal, payload, ok := readTurnRequest(response, httptest.NewRequest("POST", TurnPath, strings.NewReader(string(raw))))
			require.False(t, ok)
			require.Empty(t, runID)
			require.Equal(t, JournalRequest{}, journal)
			require.Nil(t, payload)
			require.Equal(t, 400, response.Code)
			require.JSONEq(t, `{"status":"error","code":"request_invalid"}`, response.Body.String())
		})
	}
}

func TestChatAdmissionUnitIdentityAndTokenBoundaries(t *testing.T) {
	for _, item := range []struct {
		name, run, leg, token string
		accepted              bool
	}{
		{"ASCII identity boundary", strings.Repeat("r", 160), strings.Repeat("l", 160), strings.Repeat("a", 32), true},
		{"UTF8 byte boundary", strings.Repeat("é", 80), "leg", strings.Repeat("_", 128), true},
		{"run one byte over", strings.Repeat("r", 161), "leg", strings.Repeat("a", 32), false},
		{"leg one byte over", "run", strings.Repeat("l", 161), strings.Repeat("a", 32), false},
		{"UTF8 byte overflow", strings.Repeat("é", 81), "leg", strings.Repeat("a", 32), false},
		{"token one below", "run", "leg", strings.Repeat("a", 31), false},
		{"token one over", "run", "leg", strings.Repeat("a", 129), false},
	} {
		t.Run(item.name, func(t *testing.T) {
			raw := admissionUnitBody(t, func(f, j map[string]any) { f["runId"] = item.run; j["legId"] = item.leg; j["token"] = item.token })
			response := httptest.NewRecorder()
			run, journal, payload, ok := readTurnRequest(response, httptest.NewRequest("POST", TurnPath, strings.NewReader(string(raw))))
			require.Equal(t, item.accepted, ok)
			if item.accepted {
				require.Equal(t, item.run, run)
				require.Equal(t, item.leg, journal.LegID)
				require.Equal(t, item.token, journal.Token)
				require.NotContains(t, string(payload), item.token)
			} else {
				require.Equal(t, 400, response.Code)
				require.Nil(t, payload)
			}
		})
	}
}

func TestChatAdmissionUnitStrictCallbackJSONAndTrailingData(t *testing.T) {
	for _, raw := range []string{``, `{`, `[]`, `{"runId":1}`, `{"runId":"run","unknown":true}`, `{"runId":"run"}{}`, `{"runId":"run"} true`, `{"runId":"run"} broken`} {
		response := httptest.NewRecorder()
		var decoded cancelRequest
		require.False(t, decodeBounded(response, httptest.NewRequest("POST", CancelPath, strings.NewReader(raw)), &decoded), raw)
		require.Equal(t, 400, response.Code)
		require.JSONEq(t, `{"status":"error","code":"request_invalid"}`, response.Body.String())
	}
	response := httptest.NewRecorder()
	var decoded cancelRequest
	require.True(t, decodeBounded(response, httptest.NewRequest("POST", CancelPath, strings.NewReader(" {\"runId\":\"run\"} \n\t")), &decoded))
	require.Equal(t, "run", decoded.RunID)
}

func TestChatAdmissionUnitScopeComesFromAuthenticationAndOptionalRepository(t *testing.T) {
	for _, user := range []*db.User{nil, {ID: 0, Username: "alice"}, {ID: -1, Username: "alice"}, {ID: 1, Username: ""}, {ID: 1, Username: strings.Repeat("x", 161)}} {
		request := httptest.NewRequest("POST", TurnPath, nil)
		request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, user))
		scope, err := requestScope(request)
		require.ErrorIs(t, err, ErrForbidden)
		require.Equal(t, Scope{}, scope)
	}
	for _, repo := range []*db.Repository{nil, {ID: 42}} {
		ctx := context.WithValue(context.Background(), middleware.UserContextKey, &db.User{ID: 7, Username: "alice"})
		if repo != nil {
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Repository: repo}, middleware.PermissionRead)
		}
		scope, err := requestScope(httptest.NewRequest("POST", TurnPath, nil).WithContext(ctx))
		require.NoError(t, err)
		expected := Scope{UserID: 7, Owner: "alice"}
		if repo != nil {
			expected.RepositoryID = 42
		}
		require.Equal(t, expected, scope)
	}
}

func TestChatAdmissionUnitPublicErrorsKeepLiteralWireMeaning(t *testing.T) {
	for _, item := range []struct {
		err    error
		status int
		code   string
	}{
		{ErrInvalidRequest, 400, "request_invalid"}, {ErrInvalidFrame, 400, "request_invalid"}, {ErrForbidden, 403, "forbidden"}, {ErrNotFound, 404, "not-found"},
		{ErrRetired, 410, "retired"}, {ErrCursorConflict, 409, "cursor"}, {ErrConflict, 409, "conflict"}, {ErrTerminal, 409, "terminal"}, {ErrLimit, 409, "limit"},
		{ErrCorrupt, 500, "corrupt"}, {errors.New("private database diagnostic"), 503, "storage_failed"},
	} {
		response := httptest.NewRecorder()
		publicError(response, fmt.Errorf("wrapped: %w", item.err))
		require.Equal(t, item.status, response.Code)
		require.JSONEq(t, fmt.Sprintf(`{"status":"error","code":%q}`, item.code), response.Body.String())
		require.Equal(t, "application/json", response.Header().Get("Content-Type"))
		require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	}
}

func TestChatAdmissionUnitRetryDelaySaturatesWithoutOverflow(t *testing.T) {
	for _, item := range []struct {
		generation int64
		seconds    int64
	}{
		{math.MinInt64, 1}, {-1, 1}, {0, 1}, {1, 1}, {2, 2}, {6, 32}, {7, 60}, {8, 60}, {math.MaxInt64, 60},
	} {
		require.Equal(t, time.Duration(item.seconds)*time.Second, retryDelay(item.generation))
	}
}

type chatAdmissionReadFailure struct {
	raw  []byte
	err  error
	sent bool
}

func (r *chatAdmissionReadFailure) Read(p []byte) (int, error) {
	if r.sent {
		return 0, io.EOF
	}
	r.sent = true
	return copy(p, r.raw), r.err
}

func TestChatAdmissionUnitReadErrorsAndNonObjectRootsFailClosed(t *testing.T) {
	for _, raw := range []string{"", "{", "null", "[]", "true", `"run"`, `{} {}`} {
		response := httptest.NewRecorder()
		_, _, payload, ok := readTurnRequest(response, httptest.NewRequest("POST", TurnPath, strings.NewReader(raw)))
		require.False(t, ok, raw)
		require.Nil(t, payload)
		require.Equal(t, 400, response.Code)
		require.JSONEq(t, `{"status":"error","code":"request_invalid"}`, response.Body.String())
	}
	for _, failure := range []error{io.ErrUnexpectedEOF, context.Canceled} {
		request := httptest.NewRequest("POST", TurnPath, nil)
		request.Body = io.NopCloser(&chatAdmissionReadFailure{raw: admissionUnitBody(t, nil), err: failure})
		response := httptest.NewRecorder()
		_, _, payload, ok := readTurnRequest(response, request)
		require.False(t, ok, "complete JSON bytes do not make a failed body read admissible")
		require.Nil(t, payload)
		require.Equal(t, 400, response.Code)
		require.JSONEq(t, `{"status":"error","code":"request_invalid"}`, response.Body.String())
	}
}

func TestChatAdmissionUnitRespectsTransportBodyLimit(t *testing.T) {
	for _, turn := range []bool{false, true} {
		response := httptest.NewRecorder()
		raw := `{"runId":"` + strings.Repeat("r", 80) + `"}`
		if turn {
			raw = string(admissionUnitBody(t, nil))
		}
		request := httptest.NewRequest("POST", TurnPath, strings.NewReader(raw))
		// A host may impose a stricter body cap on the incoming HTTP reader.
		// Use the actual net/http boundary to verify its typed error is kept.
		request.Body = http.MaxBytesReader(response, request.Body, 32)
		if turn {
			_, _, _, ok := readTurnRequest(response, request)
			require.False(t, ok)
		} else {
			var body cancelRequest
			require.False(t, decodeBounded(response, request, &body))
		}
		require.Equal(t, 413, response.Code)
		require.JSONEq(t, `{"status":"error","code":"request_too_large"}`, response.Body.String())
	}
}

func TestChatAdmissionUnitRoutePayloadByteBoundary(t *testing.T) {
	base := admissionUnitBody(t, func(f, j map[string]any) { f["instructions"] = "" })
	for _, item := range []struct {
		size     int
		accepted bool
	}{{1048575, true}, {1048576, true}, {1048577, false}} {
		raw := admissionUnitBody(t, func(f, j map[string]any) { f["instructions"] = strings.Repeat("x", item.size-len(base)) })
		require.Len(t, raw, item.size)
		response := httptest.NewRecorder()
		_, journal, payload, ok := readTurnRequest(response, httptest.NewRequest("POST", TurnPath, strings.NewReader(string(raw))))
		require.Equal(t, item.accepted, ok)
		if item.accepted {
			require.Equal(t, "leg", journal.LegID)
			require.NotContains(t, string(payload), "journal")
		} else {
			require.Equal(t, 413, response.Code)
			require.Nil(t, payload)
		}
	}
}
