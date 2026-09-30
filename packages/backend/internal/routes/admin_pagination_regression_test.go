package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestAdminPaginationDefaultsAndExplicitSizes(t *testing.T) {
	cases := []struct {
		name, query string
		offset      int32
		size, page  int
	}{
		{"default first", "", 0, 50, 1},
		{"default second", "page=2", 50, 50, 2},
		{"default third", "page=3", 100, 50, 3},
		{"legacy thirty", "page=2&per_page=30", 30, 30, 2},
		{"cursor thirty", "cursor=30&limit=30", 30, 30, 2},
		{"cursor default", "cursor=50", 50, 50, 2},
		{"bad size", "page=2&per_page=101", 0, 0, 0},
	}
	for _, tc := range cases {
		t.Run("audit/"+tc.name, func(t *testing.T) {
			called := false
			h := AdminAuditHandler{Queries: &mockAuditLogQuerier{listAuditLogsFilteredFn: func(_ context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error) {
				called = true
				require.Equal(t, tc.offset, arg.PageOffset)
				require.Equal(t, int32(tc.size), arg.PageLimit)
				return []db.AuditLog{}, nil
			}}}
			req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=2024-01-01&"+tc.query, nil)
			rec := httptest.NewRecorder()
			h.ListAuditLogs(rec, req)
			if tc.size == 0 {
				require.Equal(t, http.StatusBadRequest, rec.Code)
			} else {
				require.Equal(t, http.StatusOK, rec.Code)
				require.JSONEq(t, "[]", rec.Body.String())
			}
			require.Equal(t, tc.size != 0, called)
		})
	}
}
