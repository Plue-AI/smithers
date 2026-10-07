package routes

import (
	"context"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type branchDiffFixture struct {
	calls  int
	branch string
	err    error
	result services.BranchDiff
}

func (f *branchDiffFixture) TODOBranchDiff(_ context.Context, branch string) (services.BranchDiff, error) {
	f.calls++
	f.branch = branch
	return f.result, f.err
}
func TestTODOBranchDiffRoute(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reader *branchDiffFixture
		status int
		body   string
	}{
		{name: "dark", status: 503, body: `{"code":"dependency_unavailable","class":"infra","message":"TODO PR publication dependencies are unavailable"}`},
		{name: "accepted file", reader: &branchDiffFixture{result: services.BranchDiff{Files: []services.BranchDiffModel{{Path: "retry.go", Branch: "branch-id", Against: services.BranchDiffAgainst{Kind: "item_base", Rev: "prefix"}, Change: "modified", Hunks: []services.BranchDiffHunk{}}}}}, status: 200, body: `{"files":[{"path":"retry.go","branch":"branch-id","against":{"kind":"item_base","rev":"prefix"},"change":"modified","hunks":[]}]}`},
		{name: "accepted empty", reader: &branchDiffFixture{}, status: 200, body: `{"files":[]}`},
		{name: "wrapped gate", reader: &branchDiffFixture{err: fmt.Errorf("prefix: %w", &services.TODOPrUnavailable{})}, status: 503, body: `{"code":"dependency_unavailable","class":"infra","message":"TODO PR publication dependencies are unavailable"}`},
		{name: "permission", reader: &branchDiffFixture{err: pkgerrors.Forbidden("branch access refused")}, status: 403},
		{name: "missing", reader: &branchDiffFixture{err: pkgerrors.NotFound("branch not found")}, status: 404},
		{name: "read failure", reader: &branchDiffFixture{err: fmt.Errorf("read failed")}, status: 503, body: `{"code":"branch_machine_unavailable","class":"infra","message":"Branch unavailable"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &BranchDiffHandler{}
			if tc.reader != nil {
				h.Reader = tc.reader
			}
			router := chi.NewRouter()
			router.Get("/api/branches/{b}/diff", h.Diff)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest("GET", "/api/branches/branch-id/diff", nil))
			require.Equal(t, tc.status, rec.Code)
			if tc.body != "" {
				require.JSONEq(t, tc.body, rec.Body.String())
			}
			if tc.reader != nil {
				require.Equal(t, 1, tc.reader.calls)
				require.Equal(t, "branch-id", tc.reader.branch)
			}
		})
	}
}

func TestTODOBranchDiffRejectsSelectorsBeforeRead(t *testing.T) {
	for _, query := range []string{"entry=burst-1", "entry=", "snapshot_before=before&snapshot_after=after", "entry=first&entry=second", "unknown=value"} {
		t.Run(query, func(t *testing.T) {
			reader := &branchDiffFixture{}
			router := chi.NewRouter()
			router.Get("/api/branches/{b}/diff", (&BranchDiffHandler{Reader: reader}).Diff)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest("GET", "/api/branches/branch-id/diff?"+query, nil))
			require.Equal(t, 400, rec.Code)
			require.JSONEq(t, `{"code":"bad_request","class":"user","message":"Unsupported diff selector"}`, rec.Body.String())
			require.Zero(t, reader.calls)
		})
	}
}
