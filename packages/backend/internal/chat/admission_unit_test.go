package chat

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func TestChatAdmissionUnitStrictCallbackJSONAndTrailingData(t *testing.T) {
	for _, raw := range []string{``, `{`, `[]`, `{"runId":1}`, `{"runId":"run","unknown":true}`, `{"runId":"run"}{}`, `{"runId":"run"} true`, `{"runId":"run"} broken`} {
		response := httptest.NewRecorder()
		var decoded struct {
			RunID string `json:"runId"`
		}
		require.False(t, decodeBounded(response, httptest.NewRequest("POST", ReplayPath, strings.NewReader(raw)), &decoded), raw)
		require.Equal(t, 400, response.Code)
		require.JSONEq(t, `{"status":"error","code":"request_invalid"}`, response.Body.String())
	}
	response := httptest.NewRecorder()
	var decoded struct {
		RunID string `json:"runId"`
	}
	require.True(t, decodeBounded(response, httptest.NewRequest("POST", ReplayPath, strings.NewReader(" {\"runId\":\"run\"} \n\t")), &decoded))
	require.Equal(t, "run", decoded.RunID)
}

func TestChatAdmissionUnitScopeComesFromAuthenticationAndOptionalRepository(t *testing.T) {
	for _, user := range []*db.User{nil, {ID: 0, Username: "alice"}, {ID: -1, Username: "alice"}, {ID: 1, Username: ""}, {ID: 1, Username: strings.Repeat("x", 161)}} {
		request := httptest.NewRequest("POST", "/api/conversations/main/prompt", nil)
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
		scope, err := requestScope(httptest.NewRequest("POST", "/api/conversations/main/prompt", nil).WithContext(ctx))
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
