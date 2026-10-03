package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// readProvingVerifier grants read proof only to the users in readers.
type readProvingVerifier struct {
	mockGitHubRepoAccessVerifier
	readers map[int64]bool
}

func (v *readProvingVerifier) GitHubRepoReadAuthorized(_ context.Context, userID int64, _, _ string) bool {
	return v.readers[userID]
}

// TestImportedSourceToken_StalePublicFlagDoesNotOpenAPrivateRepo is the
// regression test for the proxy gap: an imported-source token was minted from
// import provenance plus github_app_installation_repositories.is_private,
// which only installation webhooks write. A repo made private after install
// kept is_private = FALSE, so anyone who had imported it while public kept
// reading it through the proxy.
func TestImportedSourceToken_StalePublicFlagDoesNotOpenAPrivateRepo(t *testing.T) {
	const installationID = int64(9902)
	invalidateCachedInstallationToken(installationID)
	t.Cleanup(func() { invalidateCachedInstallationToken(installationID) })

	var mu sync.Mutex
	visibilityChecks := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/repos/victimcorp/tool" {
			mu.Lock()
			visibilityChecks++
			mu.Unlock()
			// GitHub's current answer: the repo is private now.
			_, _ = w.Write([]byte(`{"id":5,"private":true}`))
			return
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"token":"ghs_full_installation","expires_at":"` + time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `"}`))
	}))
	t.Cleanup(server.Close)
	setTestCallerCredentials(t, "ID", "12345")
	setTestCallerCredentials(t, "PEM", testGitHubAppPrivateKeyPEM(t))
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	var corrected []string
	svc := newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				switch {
				case strings.Contains(sql, "FROM import_jobs"):
					*(dest[0].(*bool)) = true // imported while it was public
				case strings.Contains(sql, "is_private = FALSE"):
					*(dest[0].(*int64)) = installationID // the stale flag
				default:
					t.Fatalf("unexpected query: %s", sql)
				}
				return nil
			}}
		},
		execFn: func(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
			if strings.Contains(sql, "SET is_private = TRUE") {
				corrected = append(corrected, args[0].(string)+"/"+args[1].(string))
			}
			return pgconn.CommandTag{}, nil
		},
	})
	const stranger, collaborator int64 = 8, 9
	svc.SetGitHubRepoAccessVerifier(&readProvingVerifier{readers: map[int64]bool{collaborator: true}})

	token, err := svc.CreateGitHubInstallationTokenForImportedSource(context.Background(), stranger, 333, "victimcorp", "tool")
	require.Error(t, err, "a stale public flag must not mint a token for a now-private repo")
	assert.Empty(t, token.Token)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusForbidden, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeGitHubForbiddenAction, apiErr.Code)
	assert.Equal(t, []string{"victimcorp/tool"}, corrected, "the stale flag is corrected")

	// Someone whose own GitHub credential reads the private repo still can.
	token, err = svc.CreateGitHubInstallationTokenForImportedSource(context.Background(), collaborator, 334, "victimcorp", "tool")
	require.NoError(t, err)
	assert.Equal(t, "ghs_full_installation", token.Token)
}
