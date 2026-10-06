package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestMemberPermissionParsedResponses(t *testing.T) {
	for _, tc := range []struct {
		name             string
		permissionStatus int
		permissionBody   string
		userStatus       int
		userBody         string
		repoStatus       int
		want             string
		wantError        bool
	}{
		{"mismatched user ID", 200, `{"permission":"write","user":{"id":999}}`, 0, "", 0, "", true},
		{"missing user ID", 200, `{"permission":"write"}`, 0, "", 0, "", true},
		{"write", 200, `{"user":{"id":102},"permission":"write","role_name":"write"}`, 0, "", 0, "write", false},
		{"maintain", 200, `{"user":{"id":102},"permission":"write","role_name":"maintain"}`, 0, "", 0, "admin", false},
		{"read", 200, `{"user":{"id":102},"permission":"read","role_name":"read"}`, 0, "", 0, "", false},
		{"contradictory read", 200, `{"user":{"id":102},"permission":"read","role_name":"admin"}`, 0, "", 0, "", false},
		{"contradictory none", 200, `{"user":{"id":102},"permission":"none","role_name":"write"}`, 0, "", 0, "", false},
		{"none", 200, `{"user":{"id":102},"permission":"none","role_name":"none"}`, 0, "", 0, "", false},
		{"empty", 200, `{}`, 0, "", 0, "", true},
		{"unknown permission", 200, `{"user":{"id":102},"permission":"future"}`, 0, "", 0, "", true},
		{"malformed", 200, `{`, 0, "", 0, "", true},
		{"404 confirmed loss", 404, `{}`, 200, `{"id":102,"login":"writer"}`, 200, "", false},
		{"404 installation absent", 404, `{}`, 200, `{"id":102,"login":"writer"}`, 404, "", true},
		{"404 installation forbidden", 404, `{}`, 200, `{"id":102,"login":"writer"}`, 403, "", true},
		{"404 unknown user", 404, `{}`, 404, `{}`, 200, "", false},
		{"404 wrong user", 404, `{}`, 200, `{"id":102,"login":"other"}`, 200, "", true},
		{"404 user lookup failed", 404, `{}`, 502, `{}`, 200, "", true},
		{"404 malformed user", 404, `{}`, 200, `{}`, 200, "", true},
		{"installation forbidden", 403, `{}`, 0, "", 403, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "Bearer fixture-token", r.Header.Get("Authorization"))
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/repos/acme/app/collaborators/writer/permission":
					w.WriteHeader(tc.permissionStatus)
					_, _ = w.Write([]byte(tc.permissionBody))
				case "/user/102":
					_, _ = w.Write([]byte(`{"id":102,"login":"writer"}`))
				case "/users/writer":
					require.NotZero(t, tc.userStatus)
					w.WriteHeader(tc.userStatus)
					_, _ = w.Write([]byte(tc.userBody))
				case "/repos/acme/app":
					_, _ = w.Write([]byte(`{"id":500,"full_name":"acme/app"}`))
				case "/installation/repositories":
					require.NotZero(t, tc.repoStatus)
					w.WriteHeader(tc.repoStatus)
					_, _ = w.Write([]byte(`{"total_count":1,"repositories":[{"id":500}]}`))
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			t.Setenv(envGitHubAppAPIBaseURL, server.URL)
			role, err := (&Members{}).permission(context.Background(), "fixture-token", memberRepository{Owner: "acme", Name: "app", ID: 5}, "writer", 102)
			if tc.wantError {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.Equal(t, tc.want, role)
		})
	}
}

func TestMemberPermissionRejectsUnresolvedRepositoryResponse(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"empty", 200, `{}`}, {"wrong repository", 200, `{"full_name":"other/repo"}`},
		{"malformed", 200, `{`}, {"expired token", 401, `{}`}, {"transient", 502, `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "Bearer fixture-token", r.Header.Get("Authorization"))
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/repos/acme/app/collaborators/writer/permission":
					w.WriteHeader(404)
				case "/user/102":
					_, _ = w.Write([]byte(`{"id":102,"login":"writer"}`))
				case "/users/writer":
					_, _ = w.Write([]byte(`{"id":102,"login":"writer"}`))
				case "/repos/acme/app":
					w.WriteHeader(tc.status)
					_, _ = w.Write([]byte(tc.body))
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			t.Setenv(envGitHubAppAPIBaseURL, server.URL)
			role, err := (&Members{}).permission(context.Background(), "fixture-token", memberRepository{Owner: "acme", Name: "app", ID: 5}, "writer", 102)
			require.Empty(t, role)
			require.Error(t, err)
		})
	}
}

func TestMemberPermissionStreamUsesHourlyTarget(t *testing.T) {
	now := time.Now()
	success := now.Add(-time.Hour)
	stream := GitHubSyncStream{LastSuccessAt: &success}
	raw := []byte(`{"LastSuccessAt":"` + success.Format(time.RFC3339Nano) + `","Target":3600000000000}`)
	require.NoError(t, json.Unmarshal(raw, &stream))
	require.Equal(t, "fresh", aggregateGitHubSyncHealth([]GitHubSyncStream{stream}, now).State)
	require.Equal(t, "stale", aggregateGitHubSyncHealth([]GitHubSyncStream{stream}, now.Add(time.Hour+time.Nanosecond)).State)
}

func TestMemberPermissionInstallationRepositoryProof(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		refused    bool
	}{
		{"public repository no longer in installation", `{"total_count":0,"repositories":[]}`, true},
		{"same name different numeric repository", `{"total_count":1,"repositories":[{"id":501,"full_name":"acme/app"}]}`, true},
		{"malformed listing", `{`, false},
		{"missing listing", `{}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "Bearer fixture-token", r.Header.Get("Authorization"))
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/repos/acme/app" {
					fmt.Fprint(w, `{"id":500,"full_name":"acme/app"}`)
				} else if r.URL.Path == "/installation/repositories" {
					fmt.Fprint(w, tc.body)
				} else {
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			t.Setenv(envGitHubAppAPIBaseURL, server.URL)
			err := (&Members{}).confirmInstallationRepository(t.Context(), "fixture-token", memberRepository{Owner: "acme", Name: "app", ID: 5})
			require.Error(t, err)
			var refusal *memberInstallationRefusal
			require.Equal(t, tc.refused, errors.As(err, &refusal))
		})
	}
	t.Run("second page", func(t *testing.T) {
		pages := []string{}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "Bearer fixture-token", r.Header.Get("Authorization"))
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path == "/repos/acme/app" {
				fmt.Fprint(w, `{"id":500,"full_name":"acme/app"}`)
				return
			}
			pages = append(pages, r.URL.Query().Get("page"))
			if r.URL.Query().Get("page") == "1" {
				repos := make([]map[string]int, 100)
				for i := range repos {
					repos[i] = map[string]int{"id": i + 1}
				}
				json.NewEncoder(w).Encode(map[string]any{"total_count": 101, "repositories": repos})
			} else {
				fmt.Fprint(w, `{"total_count":101,"repositories":[{"id":500}]}`)
			}
		}))
		defer server.Close()
		t.Setenv(envGitHubAppAPIBaseURL, server.URL)
		require.NoError(t, (&Members{}).confirmInstallationRepository(t.Context(), "fixture-token", memberRepository{Owner: "acme", Name: "app", ID: 5}))
		require.Equal(t, []string{"1", "2"}, pages)
	})
}

func TestMemberPermissionRejectsDifferentAccountID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/user/102", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":999,"login":"writer"}`)
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	_, err := (&Members{}).memberAccount(t.Context(), "fixture-token", memberRepository{Owner: "acme", Name: "app", ID: 5}, 102)
	require.Error(t, err)
}

type refusedMemberMinter struct{ err error }

func (m refusedMemberMinter) CreateGitHubInstallationToken(context.Context, int64, GitHubTokenScope) (GitHubInstallationToken, error) {
	return GitHubInstallationToken{}, m.err
}
func TestMemberPermissionTokenRefusals(t *testing.T) {
	for _, err := range []error{pkgerrors.Unauthorized("refused"), pkgerrors.Forbidden("refused"), pkgerrors.NotFound("refused")} {
		memberGitHub(t, "write")
		_, e := (&Members{Credentials: memberCredentials{}, Minter: refusedMemberMinter{err: err}}).installationAccess(t.Context(), memberRepository{Owner: "acme", Name: "app", ID: 5})
		var refusal *memberInstallationRefusal
		require.ErrorAs(t, e, &refusal)
	}
}
