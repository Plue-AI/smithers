package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// TestFreshRepositoryInitialFindings reads the initial change of a newly
// auto-initialized repository. No push callback ever recorded its revision,
// so the findings read must record it and answer 200 with nothing invented.
// PostgreSQL, both HTTP hops, and the Rust/jj store are real.
func TestFreshRepositoryInitialFindings(t *testing.T) {
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to the built smithers-ffi library")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := postgresfixture.Open(ctx, testdb.New(t).URL, 0)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(ctx, pool))
	var userID, repositoryID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('alice', 'alice') RETURNING id`).Scan(&userID))
	_, err = pool.Exec(ctx, `INSERT INTO owner_namespaces(lower_slug, owner_type, user_id) VALUES ('alice', 'user', $1) ON CONFLICT DO NOTHING`, userID)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name, default_bookmark) VALUES ($1, 'fresh', 'fresh', 'main') RETURNING id`, userID).Scan(&repositoryID))

	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "fresh-findings", FFILibraryPath: library}
	ffi := repohostffi.New(library)
	require.NoError(t, ffi.Load())
	backend, err := repohostserver.NewWithFFI(cfg, ffi)
	require.NoError(t, err)
	host := httptest.NewServer(backend.Handler())
	defer host.Close()
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: host.URL}, cfg.AuthToken)
	require.NoError(t, client.InitRepo(ctx, "alice", "fresh", "main", true))
	bookmarks, _, err := client.ListBookmarks(ctx, "alice", "fresh", "", 10)
	require.NoError(t, err)
	require.Len(t, bookmarks, 1)
	initial := bookmarks[0]
	require.Equal(t, "main", initial.Name)
	require.NotEmpty(t, initial.TargetChangeID)

	queries := db.New(pool)
	handler := &JJVCSHandler{RepoResolver: queries, FindingsService: services.NewChangeService(queries, client, pool)}
	router := chi.NewRouter()
	router.Get("/api/repos/{owner}/{repo}/changes/{change_id}/findings", handler.GetChangeFindings)
	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}
	revisions := func() []db.ChangeRevision {
		rows, err := queries.ListChangeRevisions(ctx, db.ListChangeRevisionsParams{RepositoryID: repositoryID, ChangeID: initial.TargetChangeID})
		require.NoError(t, err)
		return rows
	}
	require.Empty(t, revisions(), "repository creation records no revision; the read must")

	want := `{"change_id":"` + initial.TargetChangeID + `","current_seq":1,"findings":[],"analyzers":[]}`
	for range 2 {
		rec := get("/api/repos/alice/fresh/changes/" + initial.TargetChangeID + "/findings")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.JSONEq(t, want, rec.Body.String())
		recorded := revisions()
		require.Len(t, recorded, 1, "repeat reads reuse the recorded revision")
		require.Equal(t, int64(1), recorded[0].Seq)
		require.Equal(t, initial.TargetCommitID, recorded[0].CommitID)
	}
	selected := get("/api/repos/alice/fresh/changes/" + initial.TargetChangeID + "/findings?rev=1")
	require.Equal(t, http.StatusOK, selected.Code, selected.Body.String())
	require.JSONEq(t, want, selected.Body.String())

	for path, status := range map[string]int{
		"/api/repos/alice/fresh/changes/" + initial.TargetChangeID + "/findings?rev=2":    http.StatusNotFound,
		"/api/repos/alice/fresh/changes/" + initial.TargetChangeID + "/findings?rev=zero": http.StatusBadRequest,
		"/api/repos/alice/fresh/changes/qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/findings":        http.StatusNotFound,
		"/api/repos/alice/missing/changes/" + initial.TargetChangeID + "/findings":        http.StatusNotFound,
	} {
		rec := get(path)
		require.Equal(t, status, rec.Code, "%s: %s", path, rec.Body.String())
		var body map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.NotEmpty(t, body["code"], path)
	}
	require.Len(t, revisions(), 1, "refusals record nothing")
}
