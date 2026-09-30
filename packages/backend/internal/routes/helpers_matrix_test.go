package routes

import (
	stdErrors "errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestParseGitRepoParam_Matrix(t *testing.T) {
	t.Parallel()

	validCases := []struct {
		name  string
		input string
		want  string
	}{
		{name: "simple", input: "demo.git", want: "demo"},
		{name: "trimmed", input: " repo.git ", want: "repo"},
		{name: "dashed", input: "demo-repo.git", want: "demo-repo"},
		{name: "underscored", input: "demo_repo.git", want: "demo_repo"},
		{name: "dotted", input: "demo.repo.git", want: "demo.repo"},
		{name: "trailing_dot_after_trim", input: "repo..git", want: "repo."},
	}

	for _, tc := range validCases {
		tc := tc
		t.Run("valid_"+tc.name, func(t *testing.T) {
			got, err := parseGitRepoParam(tc.input)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}

	invalidCases := []string{
		"",
		" ",
		"demo",
		".git",
		"demo/.git",
		"demo/repo.git",
		"../repo.git",
		"demo..repo.git",
		"repo.git/",
		"repo.git.gitx",
	}

	for idx, input := range invalidCases {
		input := input
		t.Run(fmt.Sprintf("invalid_%02d", idx), func(t *testing.T) {
			got, err := parseGitRepoParam(input)
			requireAPIError(t, err, 400)
			assert.Empty(t, got)
		})
	}
}

func TestWriteGitHTTPError_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		err         error
		wantStatus  int
		wantBody    string
		wantAuthHdr string
	}{
		{
			name:       "bad_request",
			err:        pkgerrors.BadRequest("bad request"),
			wantStatus: 400,
			wantBody:   "bad request\n",
		},
		{
			name:        "unauthorized",
			err:         pkgerrors.Unauthorized("auth required"),
			wantStatus:  401,
			wantBody:    "auth required\n",
			wantAuthHdr: `Basic realm="Smithers Git"`,
		},
		{
			name:       "forbidden",
			err:        pkgerrors.Forbidden("nope"),
			wantStatus: 403,
			wantBody:   "nope\n",
		},
		{
			name:       "generic_error",
			err:        stdErrors.New("boom"),
			wantStatus: 500,
			wantBody:   "internal server error\n",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeGitHTTPError(rec, httptest.NewRequest(http.MethodGet, "/o/r.git/info/refs", nil), tc.err)
			assert.Equal(t, tc.wantStatus, rec.Code)
			assert.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"))
			assert.Equal(t, tc.wantBody, rec.Body.String())
			assert.Equal(t, tc.wantAuthHdr, rec.Header().Get("WWW-Authenticate"))
		})
	}
}

func TestExtractGitToken_PreferenceOrder(t *testing.T) {
	t.Parallel()

	validBearer := "smithers_" + strings.Repeat("b", 40)
	validLegacy := "smithers_" + strings.Repeat("c", 40)

	tests := []struct {
		name      string
		setup     func(r *http.Request)
		wantToken string
	}{
		{
			name: "basic_auth_wins",
			setup: func(r *http.Request) {
				r.Header.Set("Authorization", "Bearer "+validBearer)
				r.SetBasicAuth("alice", "  basic-token  ")
			},
			wantToken: "basic-token",
		},
		{
			name: "bearer_token",
			setup: func(r *http.Request) {
				r.Header.Set("Authorization", "Bearer "+validBearer)
			},
			wantToken: validBearer,
		},
		{
			name: "legacy_token_header",
			setup: func(r *http.Request) {
				r.Header.Set("Authorization", "token "+validLegacy)
			},
			wantToken: validLegacy,
		},
		{
			name: "basic_auth_blank_password_stays_blank",
			setup: func(r *http.Request) {
				r.Header.Set("Authorization", "Bearer "+validBearer)
				r.SetBasicAuth("alice", "   ")
			},
			wantToken: "",
		},
		{
			name:      "no_auth",
			setup:     func(r *http.Request) {},
			wantToken: "",
		},
		{
			name: "query_param_token_ignored",
			setup: func(r *http.Request) {
				r.URL.RawQuery = "token=" + validBearer
			},
			wantToken: "",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/git/alice/demo.git/info/refs", nil)
			tc.setup(req)
			assert.Equal(t, tc.wantToken, extractGitToken(req))
		})
	}
}

func TestParseSearchPagination_LimitMatrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for limit := -5; limit <= 105; limit++ {
		limit := limit
		t.Run(fmt.Sprintf("limit_%d", limit), func(t *testing.T) {
			caseCount++
			req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/search?cursor=30&limit=%d", limit), nil)
			cursor, gotLimit, err := parseSearchPagination(req)
			if limit <= 0 {
				requireAPIError(t, err, 400)
				assert.Empty(t, cursor)
				assert.Zero(t, gotLimit)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, "30", cursor)
			if limit > 100 {
				assert.Equal(t, 100, gotLimit)
			} else {
				assert.Equal(t, limit, gotLimit)
			}
		})
	}

	extraCases := []struct {
		name       string
		rawQuery   string
		wantCursor string
		wantLimit  int
		wantStatus int
	}{
		{name: "default_values", rawQuery: "", wantCursor: "", wantLimit: 30},
		{name: "trimmed_cursor", rawQuery: "cursor=%20%20123%20%20", wantCursor: "123", wantLimit: 30},
		{name: "non_numeric_limit", rawQuery: "limit=abc", wantStatus: 400},
		{name: "legacy_page_per_page", rawQuery: "page=3&per_page=15", wantCursor: "30", wantLimit: 15},
		{name: "legacy_invalid_page", rawQuery: "page=0", wantStatus: 400},
		{name: "legacy_invalid_per_page", rawQuery: "per_page=0", wantStatus: 400},
		{name: "legacy_rejects_oversized_per_page", rawQuery: "page=1&per_page=101", wantStatus: 400},
	}

	for _, tc := range extraCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/search?"+tc.rawQuery, nil)
			cursor, limit, err := parseSearchPagination(req)
			if tc.wantStatus != 0 {
				requireAPIError(t, err, tc.wantStatus)
				assert.Empty(t, cursor)
				assert.Zero(t, limit)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.wantCursor, cursor)
			assert.Equal(t, tc.wantLimit, limit)
		})
	}

	assert.Equal(t, 111, caseCount)
}

func TestParseWebhookDeliveryPagination_LimitMatrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for limit := -10; limit <= 40; limit++ {
		limit := limit
		t.Run(fmt.Sprintf("limit_%d", limit), func(t *testing.T) {
			caseCount++
			req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/hooks?cursor=30&limit=%d", limit), nil)
			cursor, gotLimit := parseWebhookDeliveryPagination(req)
			assert.Equal(t, "30", cursor)
			switch {
			case limit <= 0:
				assert.Equal(t, 30, gotLimit)
			case limit > 30:
				assert.Equal(t, 30, gotLimit)
			default:
				assert.Equal(t, limit, gotLimit)
			}
		})
	}

	extraCases := []struct {
		name       string
		rawQuery   string
		wantCursor string
		wantLimit  int
	}{
		{name: "default_values", rawQuery: "", wantCursor: "", wantLimit: 30},
		{name: "invalid_limit_defaults", rawQuery: "limit=abc", wantCursor: "", wantLimit: 30},
		{name: "legacy_page_per_page", rawQuery: "page=2&per_page=50", wantCursor: "30", wantLimit: 30},
		{name: "legacy_limit_alias_ignored", rawQuery: "page=2&limit=5", wantCursor: "30", wantLimit: 30},
		{name: "legacy_invalid_page_defaults_to_parse_error_path", rawQuery: "page=0", wantCursor: "", wantLimit: 30},
	}

	for _, tc := range extraCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/hooks?"+tc.rawQuery, nil)
			cursor, limit := parseWebhookDeliveryPagination(req)
			assert.Equal(t, tc.wantCursor, cursor)
			assert.Equal(t, tc.wantLimit, limit)
		})
	}

	assert.Equal(t, 51, caseCount)
}

func TestParseWorkflowArtifactRunID_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for id := -5; id <= 105; id++ {
		id := id
		t.Run(fmt.Sprintf("run_id_%d", id), func(t *testing.T) {
			caseCount++
			req := httptest.NewRequest(http.MethodGet, "/artifacts", nil)
			req = withRouteParams(req, map[string]string{"id": fmt.Sprintf("%d", id)})
			runID, err := parseWorkflowArtifactRunID(req)
			if id <= 0 {
				requireAPIError(t, err, 400)
				assert.Zero(t, runID)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, int64(id), runID)
		})
	}

	for _, raw := range []string{"", "abc", "1.5", " 2 "} {
		raw := raw
		t.Run("run_id_invalid_"+fmt.Sprintf("%q", raw), func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/artifacts", nil)
			req = withRouteParams(req, map[string]string{"id": raw})
			runID, err := parseWorkflowArtifactRunID(req)
			requireAPIError(t, err, 400)
			assert.Zero(t, runID)
		})
	}

	assert.Equal(t, 111, caseCount)
}

func TestInternalWorkflowRunForRequest_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		run         *db.WorkflowRun
		routeID     string
		wantID      int64
		wantStatus  int
		wantMessage string
	}{
		{
			name:        "missing_context",
			routeID:     "55",
			wantStatus:  500,
			wantMessage: "workflow run context not loaded",
		},
		{
			name:        "invalid_route_id",
			run:         &db.WorkflowRun{ID: 55, RepositoryID: 101},
			routeID:     "0",
			wantStatus:  400,
			wantMessage: "invalid run id",
		},
		{
			name:        "mismatched_run",
			run:         &db.WorkflowRun{ID: 55, RepositoryID: 101},
			routeID:     "56",
			wantStatus:  403,
			wantMessage: "workflow run token is not authorized for this run",
		},
		{
			name:    "matching_run",
			run:     &db.WorkflowRun{ID: 55, RepositoryID: 101},
			routeID: "55",
			wantID:  55,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/internal/runs/55/artifacts", nil)
			req = withRouteParams(req, map[string]string{"id": tc.routeID})
			if tc.run != nil {
				req = withWorkflowRunContext(req, *tc.run)
			}

			run, err := internalWorkflowRunForRequest(req)
			if tc.wantStatus != 0 {
				requireAPIErrorWithMessage(t, err, tc.wantStatus, tc.wantMessage)
				assert.Nil(t, run)
				return
			}

			require.NoError(t, err)
			require.NotNil(t, run)
			assert.Equal(t, tc.wantID, run.ID)
		})
	}
}

func TestToWorkflowArtifactResponse_Nullables(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 12, 5, 0, 0, 0, time.UTC)
	tag := "v1.2.3"
	assetName := "release.tar.gz"

	tests := []struct {
		name string
		in   db.WorkflowArtifact
	}{
		{
			name: "all_nullable_fields_present",
			in: db.WorkflowArtifact{
				ID:                1,
				RepositoryID:      2,
				WorkflowRunID:     3,
				Name:              "build.tar.gz",
				Size:              1024,
				ContentType:       "application/gzip",
				Status:            "ready",
				ConfirmedAt:       pgtype.Timestamptz{Time: now, Valid: true},
				ExpiresAt:         now.Add(24 * time.Hour),
				ReleaseTag:        pgtype.Text{String: tag, Valid: true},
				ReleaseAssetName:  pgtype.Text{String: assetName, Valid: true},
				ReleaseAttachedAt: pgtype.Timestamptz{Time: now.Add(time.Hour), Valid: true},
				CreatedAt:         now,
				UpdatedAt:         now,
			},
		},
		{
			name: "nullable_fields_absent",
			in: db.WorkflowArtifact{
				ID:            4,
				RepositoryID:  5,
				WorkflowRunID: 6,
				Name:          "artifact",
				Size:          1,
				ContentType:   "text/plain",
				Status:        "pending",
				ExpiresAt:     now,
				CreatedAt:     now,
				UpdatedAt:     now,
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := toWorkflowArtifactResponse(tc.in)
			assert.Equal(t, tc.in.ID, got.ID)
			assert.Equal(t, tc.in.RepositoryID, got.RepositoryID)
			assert.Equal(t, tc.in.WorkflowRunID, got.WorkflowRunID)
			assert.Equal(t, tc.in.Name, got.Name)
			assert.Equal(t, tc.in.Size, got.Size)
			assert.Equal(t, tc.in.ContentType, got.ContentType)
			assert.Equal(t, tc.in.Status, got.Status)
			assert.Equal(t, tc.in.ExpiresAt, got.ExpiresAt)
			assert.Equal(t, tc.in.CreatedAt, got.CreatedAt)
			assert.Equal(t, tc.in.UpdatedAt, got.UpdatedAt)
			assert.Equal(t, tc.in.ConfirmedAt.Valid, got.ConfirmedAt != nil)
			assert.Equal(t, tc.in.ReleaseTag.Valid, got.ReleaseTag != nil)
			assert.Equal(t, tc.in.ReleaseAssetName.Valid, got.ReleaseAssetName != nil)
			assert.Equal(t, tc.in.ReleaseAttachedAt.Valid, got.ReleaseAttachedAt != nil)
		})
	}
}

func requireAPIError(t *testing.T, err error, wantStatus int) {
	t.Helper()

	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *APIError, got %T", err)
	assert.Equal(t, wantStatus, apiErr.Status)
}

func requireAPIErrorWithMessage(t *testing.T, err error, wantStatus int, wantMessage string) {
	t.Helper()
	requireAPIError(t, err, wantStatus)
	assert.Equal(t, wantMessage, err.Error())
}
