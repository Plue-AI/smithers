package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// diagnosisFixture wires a fake GitHub API: the /repos/{o}/{r}/installation
// app-JWT lookup and the /repos/{o}/{r} user-token visibility probe.
type diagnosisFixture struct {
	installationStatus int
	installationBody   map[string]any
	repoStatus         int
}

func newDiagnosisService(t *testing.T, fx diagnosisFixture) *GitHubUserReposService {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/installation") {
			w.WriteHeader(fx.installationStatus)
			if fx.installationBody != nil {
				_ = json.NewEncoder(w).Encode(fx.installationBody)
			} else {
				_, _ = w.Write([]byte(`{"message":"Not Found"}`))
			}
			return
		}
		// user-token repo visibility probe
		w.WriteHeader(fx.repoStatus)
		if fx.repoStatus == http.StatusOK {
			_, _ = w.Write([]byte(`{"id":1,"full_name":"acme/widgets"}`))
		} else {
			_, _ = w.Write([]byte(`{"message":"nope"}`))
		}
	}))
	t.Cleanup(server.Close)

	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	setTestCallerCredentials(t, "ID", "123")
	setTestCallerCredentials(t, "PEM", testGitHubAppPrivateKeyPEM(t))

	return newTestGitHubUserReposService(t,
		newFakeGitHubUserReposDB(),
		fakeOAuthTokenDecrypter{token: "gho_test_token"},
		WithGitHubUserReposHTTPClient(server.Client()),
	)
}

func installationBody(permissions map[string]string) map[string]any {
	return map[string]any{
		"id":          77,
		"account":     map[string]any{"login": "acme", "type": "Organization"},
		"permissions": permissions,
	}
}

func TestDiagnoseGitHubAccessAppNotInstalled(t *testing.T) {
	service := newDiagnosisService(t, diagnosisFixture{installationStatus: http.StatusNotFound})

	diagnosis, err := service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "issues")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictAppNotInstalled, diagnosis.Verdict)
	assert.Equal(t, testCallerInstallURL, diagnosis.InstallURL)
	assert.Empty(t, diagnosis.MissingPermission)
}

func TestDiagnoseGitHubAccessPermissionMissingIssues(t *testing.T) {
	// Today's live production shape: contents/metadata/pull_requests granted,
	// NO issues permission — the /issues surface 403s while /pulls works.
	service := newDiagnosisService(t, diagnosisFixture{
		installationStatus: http.StatusOK,
		installationBody: installationBody(map[string]string{
			"contents": "write", "metadata": "read", "pull_requests": "write", "workflows": "write",
		}),
	})

	diagnosis, err := service.DiagnoseGitHubAccess(context.Background(), 1, "smithersai", "smithers", "issues")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictPermissionMissing, diagnosis.Verdict)
	assert.Equal(t, "issues:read", diagnosis.MissingPermission)
	assert.Equal(t, testCallerPermissionsURL, diagnosis.GrantURL)
	assert.Equal(t, "https://github.com/organizations/acme/settings/installations/77", diagnosis.ApproveURL)
	assert.Equal(t, int64(77), diagnosis.InstallationID)
}

func TestDiagnoseGitHubAccessPullsOkWhileIssuesMissing(t *testing.T) {
	service := newDiagnosisService(t, diagnosisFixture{
		installationStatus: http.StatusOK,
		installationBody: installationBody(map[string]string{
			"contents": "write", "metadata": "read", "pull_requests": "write",
		}),
		repoStatus: http.StatusOK,
	})

	pulls, err := service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "pulls")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictOK, pulls.Verdict)

	issues, err := service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "issues")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictPermissionMissing, issues.Verdict)
	assert.Equal(t, "issues:read", issues.MissingPermission)
}

func TestDiagnoseGitHubAccessOK(t *testing.T) {
	service := newDiagnosisService(t, diagnosisFixture{
		installationStatus: http.StatusOK,
		installationBody:   installationBody(map[string]string{"issues": "read", "metadata": "read"}),
		repoStatus:         http.StatusOK,
	})

	diagnosis, err := service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "issues")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictOK, diagnosis.Verdict)
}

func TestDiagnoseGitHubAccessNoOrgGrant(t *testing.T) {
	// App installed with the permission, but the user's own token cannot see
	// the repository (GitHub answers 404 for invisible repos).
	service := newDiagnosisService(t, diagnosisFixture{
		installationStatus: http.StatusOK,
		installationBody:   installationBody(map[string]string{"issues": "write"}),
		repoStatus:         http.StatusNotFound,
	})

	diagnosis, err := service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "issues")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictNoOrgGrant, diagnosis.Verdict)
	assert.Equal(t, "https://github.com/organizations/acme/settings/installations/77", diagnosis.ApproveURL)
}

func TestDiagnoseGitHubAccessTokenBrokenOn401(t *testing.T) {
	service := newDiagnosisService(t, diagnosisFixture{
		installationStatus: http.StatusOK,
		installationBody:   installationBody(map[string]string{"issues": "read"}),
		repoStatus:         http.StatusUnauthorized,
	})

	diagnosis, err := service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "issues")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictTokenBroken, diagnosis.Verdict)
}

func TestDiagnoseGitHubAccessTokenBrokenWhenNoAccount(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(installationBody(map[string]string{"issues": "read"}))
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	setTestCallerCredentials(t, "ID", "123")
	setTestCallerCredentials(t, "PEM", testGitHubAppPrivateKeyPEM(t))

	queries := newFakeGitHubUserReposDB()
	queries.accounts = nil // no linked oauth account at all
	service := newTestGitHubUserReposService(t,
		queries,
		fakeOAuthTokenDecrypter{token: "gho_test_token"},
		WithGitHubUserReposHTTPClient(server.Client()),
	)

	diagnosis, err := service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "issues")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictTokenBroken, diagnosis.Verdict)
}

func TestDiagnoseGitHubAccessNotConfigured(t *testing.T) {
	setTestCallerCredentials(t, "ID", "")
	setTestCallerCredentials(t, "PEM", "")

	service := newTestGitHubUserReposService(t,
		newFakeGitHubUserReposDB(),
		fakeOAuthTokenDecrypter{token: "gho_test_token"},
	)
	diagnosis, err := service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "issues")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictNotConfigured, diagnosis.Verdict)
	assert.Empty(t, diagnosis.InstallURL)
}

func TestDiagnoseGitHubAccessValidation(t *testing.T) {
	service := newDiagnosisService(t, diagnosisFixture{installationStatus: http.StatusNotFound})

	_, err := service.DiagnoseGitHubAccess(context.Background(), 0, "acme", "widgets", "issues")
	assert.Error(t, err)
	_, err = service.DiagnoseGitHubAccess(context.Background(), 1, "", "widgets", "issues")
	assert.Error(t, err)
	_, err = service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "commits")
	assert.Error(t, err)
}

func TestDiagnoseGitHubAccessUserAccountApproveURL(t *testing.T) {
	service := newDiagnosisService(t, diagnosisFixture{
		installationStatus: http.StatusOK,
		installationBody: map[string]any{
			"id":          9,
			"account":     map[string]any{"login": "will", "type": "User"},
			"permissions": map[string]string{},
		},
	})

	diagnosis, err := service.DiagnoseGitHubAccess(context.Background(), 1, "will", "dotfiles", "issues")
	require.NoError(t, err)
	assert.Equal(t, GitHubAccessVerdictPermissionMissing, diagnosis.Verdict)
	assert.Equal(t, "https://github.com/settings/installations/9", diagnosis.ApproveURL)
}

func TestDiagnoseGitHubAccessUpstreamFailureIsAnError(t *testing.T) {
	service := newDiagnosisService(t, diagnosisFixture{installationStatus: http.StatusBadGateway})

	_, err := service.DiagnoseGitHubAccess(context.Background(), 1, "acme", "widgets", "issues")
	assert.Error(t, err)
}
