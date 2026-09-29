package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type resolveCovDBTX struct {
	user *db.User
	org  *db.Organization
}

func (d *resolveCovDBTX) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (d *resolveCovDBTX) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	return nil, assert.AnError
}

func (d *resolveCovDBTX) QueryRow(ctx context.Context, query string, args ...interface{}) pgx.Row {
	switch {
	case strings.Contains(query, "FROM users") && d.user != nil:
		return resolveCovRowFor(*d.user)
	case strings.Contains(query, "FROM organizations") && d.org != nil:
		return resolveCovRowFor(*d.org)
	default:
		return &resolveCovRow{err: sql.ErrNoRows}
	}
}

func resolveCovRowFor(model any) *resolveCovRow {
	fields := reflect.ValueOf(model)
	values := make([]any, fields.NumField())
	for i := range values {
		values[i] = fields.Field(i).Interface()
	}
	return &resolveCovRow{values: values}
}

type resolveCovRow struct {
	values []any
	err    error
}

func (r *resolveCovRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return fmt.Errorf("resolve fixture: scan destinations %d, values %d", len(dest), len(r.values))
	}
	for i := range dest {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(r.values[i]))
	}
	return nil
}

func TestResolveCovDBTXOrgScan(t *testing.T) {
	t.Parallel()

	org := db.Organization{
		ID: 3, Name: "Acme", LowerName: "acme", Description: "description", Visibility: "public",
		Website: "https://example.com", Location: "Earth",
		CreatedAt:      time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC),
		UpdatedAt:      time.Date(2026, 7, 8, 0, 0, 0, 0, time.UTC),
		FactoryOwnerID: pgtype.Int8{Int64: 42, Valid: true},
	}
	got, err := db.New(&resolveCovDBTX{org: &org}).GetOrgByLowerName(context.Background(), org.LowerName)
	require.NoError(t, err)
	assert.Equal(t, org, got)
}

func TestResolve_Cov_GetResolveUserOrgAndNotFound(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC)

	t.Run("resolves user before org", func(t *testing.T) {
		h := &ResolveHandler{Queries: db.New(&resolveCovDBTX{
			user: &db.User{
				ID: 1, Username: "Alice", LowerUsername: "alice", UserType: "human", IsActive: true,
				Email: pgtype.Text{}, LowerEmail: pgtype.Text{}, LastLoginAt: pgtype.Timestamptz{}, DeletedAt: pgtype.Timestamptz{},
				CreatedAt: now, UpdatedAt: now,
			},
			org: &db.Organization{ID: 2, Name: "AliceOrg", LowerName: "alice", Visibility: "public", CreatedAt: now, UpdatedAt: now},
		})}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/resolve/ALICE", nil), map[string]string{"name": " ALICE "})
		rec := httptest.NewRecorder()

		h.GetResolve(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body ResolveResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, ResolveResponse{Type: "user", ID: 1, Name: "Alice"}, body)
	})

	t.Run("falls back to org", func(t *testing.T) {
		h := &ResolveHandler{Queries: db.New(&resolveCovDBTX{
			org: &db.Organization{ID: 3, Name: "Acme", LowerName: "acme", Visibility: "public", CreatedAt: now, UpdatedAt: now},
		})}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/resolve/acme", nil), map[string]string{"name": "acme"})
		rec := httptest.NewRecorder()

		h.GetResolve(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body ResolveResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, ResolveResponse{Type: "org", ID: 3, Name: "Acme"}, body)
	})

	t.Run("not found when neither exists", func(t *testing.T) {
		h := &ResolveHandler{Queries: db.New(&resolveCovDBTX{})}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/resolve/missing", nil), map[string]string{"name": "missing"})
		rec := httptest.NewRecorder()

		h.GetResolve(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Contains(t, rec.Body.String(), "user or organization not found")
	})
}
