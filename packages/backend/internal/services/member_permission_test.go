package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

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
		{"write", 200, `{"permission":"write","role_name":"write"}`, 0, "", 0, "write", false},
		{"maintain", 200, `{"permission":"write","role_name":"maintain"}`, 0, "", 0, "admin", false},
		{"read", 200, `{"permission":"read","role_name":"read"}`, 0, "", 0, "", false},
		{"none", 200, `{"permission":"none","role_name":"none"}`, 0, "", 0, "", false},
		{"empty", 200, `{}`, 0, "", 0, "", true},
		{"unknown permission", 200, `{"permission":"future"}`, 0, "", 0, "", true},
		{"malformed", 200, `{`, 0, "", 0, "", true},
		{"404 confirmed loss", 404, `{}`, 200, `{"id":102,"login":"writer"}`, 200, "", false},
		{"404 installation absent", 404, `{}`, 200, `{"id":102,"login":"writer"}`, 404, "", true},
		{"404 installation forbidden", 404, `{}`, 200, `{"id":102,"login":"writer"}`, 403, "", true},
		{"404 unknown user", 404, `{}`, 404, `{}`, 0, "", true},
		{"404 wrong user", 404, `{}`, 200, `{"id":102,"login":"other"}`, 0, "", true},
		{"404 user lookup failed", 404, `{}`, 502, `{}`, 0, "", true},
		{"404 malformed user", 404, `{}`, 200, `{}`, 0, "", true},
		{"installation forbidden", 403, `{}`, 0, "", 0, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/repos/acme/app/collaborators/writer/permission":
					w.WriteHeader(tc.permissionStatus)
					_, _ = w.Write([]byte(tc.permissionBody))
				case "/users/writer":
					require.NotZero(t, tc.userStatus)
					w.WriteHeader(tc.userStatus)
					_, _ = w.Write([]byte(tc.userBody))
				case "/repos/acme/app":
					require.NotZero(t, tc.repoStatus)
					w.WriteHeader(tc.repoStatus)
					_, _ = w.Write([]byte(`{"full_name":"acme/app"}`))
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			t.Setenv(envGitHubAppAPIBaseURL, server.URL)
			role, err := (&Members{}).permission(context.Background(), "fixture-token", memberRepository{Owner: "acme", Name: "app", ID: 5}, "writer")
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
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/repos/acme/app/collaborators/writer/permission":
					w.WriteHeader(404)
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
			role, err := (&Members{}).permission(context.Background(), "fixture-token", memberRepository{Owner: "acme", Name: "app", ID: 5}, "writer")
			require.Empty(t, role)
			require.Error(t, err)
		})
	}
}
