package services

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func requireGitHubFailure(t *testing.T, err error, code pkgerrors.Code) *pkgerrors.APIError {
	t.Helper()
	var failure *pkgerrors.APIError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, code, failure.Code)
	require.Equal(t, pkgerrors.ClassGitHub, failure.Class)
	require.NotContains(t, failure.Message, "secret-upstream")
	return failure
}

func TestGitHubResponseFailureThroughConditionalAdapter(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		code   pkgerrors.Code
	}{
		{"unauthorized", 401, `{"message":"secret-upstream"}`, pkgerrors.CodeGitHubPermission},
		{"forbidden", 403, `{"message":"secret-upstream"}`, pkgerrors.CodeGitHubPermission},
		{"missing resource", 404, `{"message":"secret-upstream"}`, pkgerrors.CodeGitHubPermission},
		{"outage", 503, `{"message":"secret-upstream"}`, pkgerrors.CodeGitHubUnavailable},
		{"malformed", 200, `{"secret-upstream":`, pkgerrors.CodeGitHubUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			minter, upstream := newScopedTokenMinter(t)
			var reads atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/access_tokens") {
					upstream.Handler().ServeHTTP(w, r)
					return
				}
				reads.Add(1)
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer proxy.Close()
			t.Setenv(envGitHubAppAPIBaseURL, proxy.URL)
			client := NewGitHubUserReposService(nil, nil, WithGitHubUserReposHTTPClient(proxy.Client()))
			read := client.SyncedRepoConditionalFetcherFactory(minter)(db.GithubSyncedRepo{OwnerLogin: "acme", RepoName: "app", InstallationID: pgtype.Int8{Int64: 91, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 100, Valid: true}})
			_, err := read(t.Context(), "issues", url.Values{}, "")
			requireGitHubFailure(t, err, tc.code)
			require.EqualValues(t, 1, reads.Load())
		})
	}
}

func TestGitHubResponseFailureMissingInstallationIsDistinct(t *testing.T) {
	for _, tc := range []struct {
		status int
		code   pkgerrors.Code
	}{
		{401, pkgerrors.CodeGitHubPermission}, {403, pkgerrors.CodeGitHubPermission},
		{404, pkgerrors.CodeGitHubNotInstalled}, {503, pkgerrors.CodeGitHubUnavailable},
	} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			minter, _ := newScopedTokenMinter(t)
			calls := scopedTokenServer(t, tc.status, `{"message":"secret-upstream"}`)
			_, err := minter.CreateGitHubInstallationToken(t.Context(), 91, GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"metadata": "read"}})
			requireGitHubFailure(t, err, tc.code)
			require.Equal(t, 1, *calls)
		})
	}
}

func TestGitHubResponseFailureOptionalDiscoveryStaysAbsent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	defer server.Close()
	_, found, err := fetchRepoInstallation(t.Context(), server.Client(), server.URL, "jwt", "acme", "app")
	require.NoError(t, err)
	require.False(t, found)
}

func TestGitHubResponseFailureTransportAndCancellation(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			for _, cancelled := range []bool{false, true} {
				ctx, cancel := context.WithCancel(t.Context())
				var calls atomic.Int32
				client := &http.Client{Transport: githubUserReposHRoundTrip(func(*http.Request) (*http.Response, error) {
					calls.Add(1)
					if cancelled {
						cancel()
						return nil, ctx.Err()
					}
					return nil, errors.New("secret-upstream token in transport error")
				})}
				api := &landingGitHubAPI{client: client, baseURL: func() string { return "https://github.invalid" }}
				_, err := api.request(ctx, "secret-upstream", method, "/repos/acme/app/issues", nil, nil)
				if cancelled {
					require.ErrorIs(t, err, context.Canceled)
				} else {
					requireGitHubFailure(t, err, pkgerrors.CodeGitHubUnavailable)
				}
				require.EqualValues(t, 1, calls.Load(), "a lost write acknowledgment is never retried here")
				cancel()
			}
		})
	}
}

func TestGitHubResponseFailurePreservesCommittedStream(t *testing.T) {
	service, pool, _ := newFetchedFixture(t)
	minter, upstream := newScopedTokenMinter(t)
	ctx := t.Context()
	row, err := db.New(pool).EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{OwnerLogin: "acme", RepoName: "app", InstallationID: pgtype.Int8{Int64: 91, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 100, Valid: true}, SyncMetadata: true, EnrolledVia: GitHubSyncedRepoEnrolledViaInstallation})
	require.NoError(t, err)
	upstream.OpenIssue("acme/app", "acme", "Saved title", "Saved body")
	var deny atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if deny.Load() && r.URL.Path == "/repos/acme/app/issues" {
			w.WriteHeader(403)
			_, _ = io.WriteString(w, `{"message":"secret-upstream"}`)
			return
		}
		upstream.Handler().ServeHTTP(w, r)
	}))
	defer proxy.Close()
	t.Setenv(envGitHubAppAPIBaseURL, proxy.URL)
	client := NewGitHubUserReposService(db.New(pool), nil, WithGitHubUserReposHTTPClient(proxy.Client()))
	service.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	allowFetched(service)
	require.NoError(t, service.backfillResource(ctx, row, "issues", nil))
	require.NoError(t, service.backfillResource(ctx, row, "issues", nil))
	cursor := service.fetchedUpdatedCursor(row, "issues")
	require.False(t, cursor.IsZero())
	before := fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`)
	var saved json.RawMessage
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM github_synced_issues WHERE synced_repo_id=$1`, row.ID).Scan(&saved))
	deny.Store(true)
	requireGitHubFailure(t, service.backfillResource(ctx, row, "issues", nil), pkgerrors.CodeGitHubPermission)
	require.Equal(t, before, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	var after json.RawMessage
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM github_synced_issues WHERE synced_repo_id=$1`, row.ID).Scan(&after))
	require.JSONEq(t, string(saved), string(after))
	require.Equal(t, cursor, service.fetchedUpdatedCursor(row, "issues"))
	// An unchanged retry uses the previously committed validator and succeeds.
	deny.Store(false)
	require.NoError(t, service.backfillResource(ctx, row, "issues", nil))
	service.install.mu.Lock()
	afterCursor := service.install.streams[syncedStreamKey(row, "issues")].updated
	service.install.mu.Unlock()
	require.Equal(t, cursor, afterCursor)
	require.Equal(t, before, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
}

func TestGitHubResponseFailureRejectsIncompleteCredentialReads(t *testing.T) {
	minter, _ := newScopedTokenMinter(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body := `{"token":"valid-looking-token","expires_at":"2030-01-01T00:00:00Z"}`
		switch r.URL.Path {
		case "/app/installations":
			body = `[]`
		case "/installation/repositories":
			body = `{"repositories":[]}`
		case "/repos/acme/app/installation":
			body = `{"id":91}`
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)+10))
		_, _ = io.WriteString(w, body)
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	for range 2 {
		_, err := minter.CreateGitHubInstallationToken(t.Context(), 91, GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"metadata": "read"}})
		requireGitHubFailure(t, err, pkgerrors.CodeGitHubUnavailable)
	}
	require.EqualValues(t, 2, calls.Load(), "a truncated credential must not enter the token cache")
	_, err := minter.listGitHubAppInstallations(t.Context(), "jwt")
	requireGitHubFailure(t, err, pkgerrors.CodeGitHubUnavailable)
	_, err = minter.listGitHubInstallationRepositories(t.Context(), "token")
	requireGitHubFailure(t, err, pkgerrors.CodeGitHubUnavailable)
	_, _, err = fetchRepoInstallation(t.Context(), server.Client(), server.URL, "jwt", "acme", "app")
	requireGitHubFailure(t, err, pkgerrors.CodeGitHubUnavailable)
}

func TestGitHubResponseFailureRejectsOversizedAndMalformedToken(t *testing.T) {
	for _, body := range []string{
		`{"token":"valid-looking-token","expires_at":"2030-01-01T00:00:00Z"}` + strings.Repeat(" ", 1<<20),
		`{"token":"valid-looking-token","expires_at":"2030-01-01T00:00:00Z","token":3}`,
	} {
		minter, _ := newScopedTokenMinter(t)
		calls := scopedTokenServer(t, http.StatusCreated, body)
		for range 2 {
			_, err := minter.CreateGitHubInstallationToken(t.Context(), 91, GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"metadata": "read"}})
			requireGitHubFailure(t, err, pkgerrors.CodeGitHubUnavailable)
		}
		require.Equal(t, 2, *calls, "unusable credentials are never cached")
	}
}
