package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestGithubRepoList_Cov_OptionsUnavailableAndNoInstall(t *testing.T) {
	svc := NewGitHubRepoListService(nil, nil)
	_, err := svc.ListInstallationRepositories(context.Background(), 1, url.Values{})
	if err == nil || !strings.Contains(err.Error(), "service unavailable") {
		t.Fatalf("unavailable err = %v", err)
	}

	svc = NewGitHubRepoListService(fakeRepoListDB{row: fakeRepoListRow{err: pgx.ErrNoRows}}, fakeRepoListTokenIssuer{})
	_, err = svc.ListInstallationRepositories(context.Background(), 1, url.Values{})
	if err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("no install err = %v", err)
	}

	custom := &http.Client{Timeout: time.Second}
	svc = NewGitHubRepoListService(fakeRepoListDB{}, fakeRepoListTokenIssuer{}, WithGitHubRepoListHTTPClient(custom), WithGitHubRepoListHTTPClient(nil))
	if svc.httpClient != custom {
		t.Fatal("non-nil HTTP client option was not applied")
	}
}

func TestGithubRepoList_Cov_ListSuccessFiltersQueryAndHeaders(t *testing.T) {
	var rawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawQuery = r.URL.RawQuery
		if r.Header.Get("Authorization") != "Bearer install-token" || r.Header.Get("Accept") == "" || r.Header.Get("X-GitHub-Api-Version") == "" {
			t.Fatalf("headers = %+v", r.Header)
		}
		w.Header().Set("Link", `<https://api.github.test/next>; rel="next"`)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"repositories": []map[string]any{{
				"id": 1, "full_name": "acme/demo", "name": "demo", "owner": map[string]any{"login": "acme"},
			}},
		})
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	svc := NewGitHubRepoListService(
		fakeRepoListDB{row: fakeRepoListRow{owner: "acme", repo: "demo"}},
		fakeRepoListTokenIssuer{instID: 42},
		WithGitHubRepoListHTTPClient(server.Client()),
	)
	result, err := svc.ListInstallationRepositories(context.Background(), 9, url.Values{
		"visibility": {"all"},
		"cursor":     {"3"},
		"ignored":    {"yes"},
	})
	if err != nil {
		t.Fatalf("ListInstallationRepositories returned error: %v", err)
	}
	if len(result.Repos) != 1 || result.Repos[0].Owner.Login != "acme" || result.Link == "" {
		t.Fatalf("result = %+v", result)
	}
	if rawQuery != "page=3&visibility=all" {
		t.Fatalf("raw query = %q", rawQuery)
	}
}

func TestGithubRepoList_Cov_UpstreamDecodeAndStatusErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{name: "server rejected", status: http.StatusTeapot, body: `{}`, want: "GitHub request failed"},
		{name: "bad json", status: http.StatusOK, body: `{`, want: "unreadable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			t.Setenv(envGitHubAppAPIBaseURL, server.URL)
			svc := NewGitHubRepoListService(fakeRepoListDB{row: fakeRepoListRow{owner: "acme", repo: "demo"}}, fakeRepoListTokenIssuer{}, WithGitHubRepoListHTTPClient(server.Client()))
			_, err := svc.ListInstallationRepositories(context.Background(), 9, url.Values{})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}
