package services

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestGitHubRepositoryResponseRejectsUnusableReads(t *testing.T) {
	for _, boundary := range []string{"user listing", "push permission", "installation listing"} {
		t.Run(boundary, func(t *testing.T) {
			for _, failure := range []string{"forbidden", "outage", "malformed", "incomplete", "oversized"} {
				t.Run(failure, func(t *testing.T) {
					var calls atomic.Int32
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
						calls.Add(1)
						body := `[{"id":777,"full_name":"acme/app"}]`
						if boundary == "push permission" {
							body = `{"id":777,"permissions":{"push":true}}`
						} else if boundary == "installation listing" {
							body = `{"repositories":[{"id":1,"full_name":"acme/app"}]}`
						}
						switch failure {
						case "forbidden":
							w.WriteHeader(403)
							body = `{"message":"secret-upstream"}`
						case "outage":
							w.WriteHeader(503)
							body = `{"message":"secret-upstream"}`
						case "malformed":
							body += "secret-upstream"
						case "incomplete":
							w.Header().Set("Content-Length", strconv.Itoa(len(body)+10))
						case "oversized":
							body += strings.Repeat(" ", 4<<20)
						}
						_, _ = io.WriteString(w, body)
					}))
					defer upstream.Close()
					t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)
					queries := newFakeGitHubUserReposDB()
					refresh := &fakeGitHubTokenRefresher{newToken: "fresh"}
					user := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "user"}, WithGitHubUserReposTokenRefresher(refresh))
					var err error
					switch boundary {
					case "user listing":
						_, err = user.ListAuthenticatedUserGitHubRepos(t.Context(), 42, url.Values{})
						require.Zero(t, queries.upsertCount(), "an incomplete listing must not enter the cache")
					case "push permission":
						var id int64
						id, err = user.VerifyUserCanPushToGitHubRepo(t.Context(), 42, "acme", "app")
						require.Zero(t, id, "an incomplete permission response cannot authorize a connection")
					case "installation listing":
						service := NewGitHubRepoListService(fakeRepoListDB{}, fakeRepoListTokenIssuer{instID: 6602})
						_, err = service.ListInstallationRepositories(t.Context(), 42, url.Values{})
					}
					code := pkgerrors.CodeGitHubUnavailable
					if failure == "forbidden" {
						code = pkgerrors.CodeGitHubPermission
					}
					requireGitHubFailure(t, err, code)
					require.Equal(t, 502, apiStatus(t, err))
					require.EqualValues(t, 1, calls.Load())
					require.Zero(t, refresh.callCount(), "only a rejected user credential may trigger refresh")
				})
			}
		})
	}
}

func TestGitHubRepositoryResponseFailureRetainsLastGoodListing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		body := `[]`
		w.Header().Set("Content-Length", "12")
		_, _ = io.WriteString(w, body)
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	queries := newFakeGitHubUserReposDB()
	queries.setRow(testRepoItems(2), time.Now().Add(-time.Hour))
	before, err := queries.GetGitHubRepoListing(t.Context(), 42)
	require.NoError(t, err)
	service := NewGitHubUserReposService(queries, fakeOAuthTokenDecrypter{token: "user"})
	err = service.syncGitHubRepoListing(t.Context(), 42)
	requireGitHubFailure(t, err, pkgerrors.CodeGitHubUnavailable)
	after, err := queries.GetGitHubRepoListing(t.Context(), 42)
	require.NoError(t, err)
	require.Equal(t, before.Payload, after.Payload)
	require.Equal(t, before.SyncedAt, after.SyncedAt)
	require.Zero(t, queries.upsertCount())
	require.Zero(t, queries.deleteCount())
	require.Equal(t, 1, queries.syncErrCount())
}

func TestGitHubRepositoryResponseCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	client := &http.Client{Transport: repoListZRoundTrip(func(*http.Request) (*http.Response, error) {
		cancel()
		return nil, context.Canceled
	})}
	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "user"}, WithGitHubUserReposHTTPClient(client))
	_, err := service.VerifyUserCanPushToGitHubRepo(ctx, 42, "acme", "app")
	require.ErrorIs(t, err, context.Canceled)
}

func TestGitHubRepositoryResponseRefreshPauseSurvivesCallers(t *testing.T) {
	key := testGitHubAppPrivateKeyPEM(t)
	for _, boundary := range []string{"full listing", "live listing", "push", "repository", "pull", "issues", "comments", "diff", "backfill", "diagnosis", "push proof", "read proof"} {
		t.Run(boundary, func(t *testing.T) {
			var reads atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/installation") {
					_, _ = io.WriteString(w, `{"id":91,"account":{"login":"acme","type":"Organization"},"permissions":{"issues":"read"}}`)
					return
				}
				reads.Add(1)
				w.WriteHeader(401)
			}))
			defer upstream.Close()
			t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)
			setTestCallerCredentials(t, "ID", "42")
			setTestCallerCredentials(t, "PEM", key)
			pause := pkgerrors.New(pkgerrors.CodeGitHubRateLimited, "GitHub rate limit reached")
			deadline := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
			pause.RetryAt, pause.RetryAfter = &deadline, 120
			refresh := &fakeGitHubTokenRefresher{err: pause}
			queries := newFakeGitHubUserReposDB()
			queries.setRow(testRepoItems(2), time.Now().Add(-time.Hour))
			service := newTestGitHubUserReposService(t, queries, fakeOAuthTokenDecrypter{token: "expired"}, WithGitHubUserReposTokenRefresher(refresh))
			ctx := t.Context()
			var err error
			switch boundary {
			case "full listing":
				err = service.syncGitHubRepoListing(ctx, 42)
				require.Zero(t, queries.deleteCount(), "a paused refresh does not revoke the last-good cache")
				require.Zero(t, queries.upsertCount())
				require.Equal(t, 1, queries.syncErrCount())
			case "live listing":
				_, err = service.ListAuthenticatedUserGitHubRepos(ctx, 42, url.Values{"visibility": {"private"}})
			case "push":
				_, err = service.VerifyUserCanPushToGitHubRepo(ctx, 42, "acme", "app")
			case "repository":
				_, err = service.GetAuthenticatedUserGitHubRepo(ctx, 42, "acme", "app")
			case "pull":
				_, err = service.GetAuthenticatedUserGitHubPull(ctx, 42, "acme", "app", 1)
			case "issues":
				_, err = service.ListAuthenticatedUserGitHubRepoMetadata(ctx, 42, "acme", "app", "issues", nil)
			case "comments":
				_, err = service.ListAuthenticatedUserGitHubIssueComments(ctx, 42, "acme", "app", 1, nil)
			case "diff":
				_, err = service.GetAuthenticatedUserGitHubPullDiff(ctx, 42, "acme", "app", 1)
			case "backfill":
				_, err = service.syncedRepoBackfillFetcher(42, "acme", "app")(ctx, "issues", nil)
			case "diagnosis":
				_, err = service.DiagnoseGitHubAccess(ctx, 42, "acme", "app", "issues")
			case "push proof":
				err = service.GitHubRepoPushAuthorized(ctx, 42, "acme", "app")
				var failure *GitHubPushProofError
				require.ErrorAs(t, err, &failure)
				require.Equal(t, GitHubPushProofUnavailable, failure.Reason)
			case "read proof":
				require.False(t, service.GitHubRepoReadAuthorized(ctx, 42, "acme", "app"))
			}
			if boundary != "push proof" && boundary != "read proof" {
				require.Same(t, pause, requireGitHubFailure(t, err, pkgerrors.CodeGitHubRateLimited))
				require.Equal(t, deadline, *pause.RetryAt)
			}
			require.Equal(t, 1, refresh.callCount())
			require.EqualValues(t, 1, reads.Load(), "a paused refresh cannot retry the repository read")
		})
	}
}

func TestGitHubRepositoryResponseMetadataClassification(t *testing.T) {
	for _, boundary := range []string{"repository", "pull", "issues", "comments", "diff"} {
		t.Run(boundary, func(t *testing.T) {
			for _, status := range []int{403, 404, 422, 503, 304} {
				t.Run(strconv.Itoa(status), func(t *testing.T) {
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
						w.WriteHeader(status)
						_, _ = io.WriteString(w, `{"message":"secret-upstream"}`)
					}))
					defer server.Close()
					t.Setenv(envGitHubAppAPIBaseURL, server.URL)
					refresh := &fakeGitHubTokenRefresher{newToken: "unexpected"}
					service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "user"}, WithGitHubUserReposTokenRefresher(refresh))
					var err error
					switch boundary {
					case "repository":
						_, err = service.GetAuthenticatedUserGitHubRepo(t.Context(), 42, "acme", "app")
					case "pull":
						_, err = service.GetAuthenticatedUserGitHubPull(t.Context(), 42, "acme", "app", 1)
					case "issues":
						_, err = service.ListAuthenticatedUserGitHubRepoMetadata(t.Context(), 42, "acme", "app", "issues", nil)
					case "comments":
						_, err = service.ListAuthenticatedUserGitHubIssueComments(t.Context(), 42, "acme", "app", 1, nil)
					case "diff":
						_, err = service.GetAuthenticatedUserGitHubPullDiff(t.Context(), 42, "acme", "app", 1)
					}
					want := pkgerrors.CodeGitHubUnavailable
					if status == 403 || status == 404 {
						want = pkgerrors.CodeGitHubPermission
					}
					requireGitHubFailure(t, err, want)
					require.Zero(t, refresh.callCount())
				})
			}
		})
	}
}

func TestGitHubRepositoryResponseDiffRateLimitPrecedesBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "45")
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(403)
		_, _ = io.WriteString(w, "incomplete")
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "user"})
	_, err := service.GetAuthenticatedUserGitHubPullDiff(t.Context(), 42, "acme", "app", 1)
	failure := requireGitHubFailure(t, err, pkgerrors.CodeGitHubRateLimited)
	require.Equal(t, 45, failure.RetryAfter)
}
