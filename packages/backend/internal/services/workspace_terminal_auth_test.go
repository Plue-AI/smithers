package services

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestOwnerTerminalCredentialAuthenticationLifetime(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'fixture','fixture') RETURNING id`, owner.ID).Scan(&repo))
	binding := fmt.Sprintf(`{"owner_login":"ben","repository_name":"fixture","repository_id":%d,"last_access_check_at":%q}`, repo, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	live := true
	auth := NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
	auth.Members = &Members{Pool: pool}
	auth.TerminalSubject = func(user, repository int64, branch, id string) bool {
		return live && user == owner.ID && repository == repo && branch == "branch-a" && id == "session-a"
	}
	registry := new(sync.Map)
	service := NewWorkspaceService(q, WithWorkspaceCredentialIssuer(auth))
	service.terminalCredentials = registry
	credential := &terminalCredential{ownerUID: 20001, registry: registry, issuer: auth, tokens: q, writer: &fakeSessionFiles{}, workspaceID: "branch-a", sessionID: "session-a", userID: owner.ID, repositoryID: repo, url: "https://install.test"}
	require.NoError(t, service.installTerminalCredential(ctx, credential))
	defer credential.Close()
	var token string
	credential.writer.(*fakeSessionFiles).mu.Lock()
	token = credential.writer.(*fakeSessionFiles).files["session-a"]
	credential.writer.(*fakeSessionFiles).mu.Unlock()
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	_, err = q.GetAuthInfoByTokenHash(ctx, hash)
	require.Error(t, err, "S2 has no persisted S1 session")
	endpoint := middleware.WithTerminalTokenLookup(service.AuthenticateOwnerTerminalToken)(middleware.AuthLoader(q, config.AuthConfig{Mode: "selfhost"})(middleware.RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, owner.ID, middleware.UserFromContext(r.Context()).ID)
		w.WriteHeader(204)
	}))))
	call := func(bearer string) int {
		req := httptest.NewRequest("GET", "/api/user", nil)
		req.Header.Set("Authorization", "Bearer "+bearer)
		w := httptest.NewRecorder()
		endpoint.ServeHTTP(w, req)
		return w.Code
	}
	require.Equal(t, 204, call(token))
	require.Equal(t, 401, call("smithers_unknown"))
	live = false
	require.Equal(t, 401, call(token))
	live = true
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=scopes||',write:repository' WHERE id=$1`, credential.tokenID)
	require.NoError(t, err)
	require.Equal(t, 401, call(token))
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, credential.tokenID, credential.scopes())
	require.NoError(t, err)
	require.Equal(t, 204, call(token))
	credential.Close()
	require.Equal(t, 401, call(token))
	var sessions int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_sessions`).Scan(&sessions))
	require.Zero(t, sessions)
}

// A composed S2 issuer switches both legacy entry points off before a runtime
// method or workspace-session insert can run.
type forbiddenLegacyTerminalRuntime struct{ workspaceapi.WorkspaceRuntime }

func TestOwnerTerminalCutoverRefusesLegacyOpen(t *testing.T) {
	service := NewWorkspaceService(&mockWorkspaceQuerier{})
	service.runtime = forbiddenLegacyTerminalRuntime{}
	service.credentialIssuer = &AuthService{TerminalSubject: func(int64, int64, string, string) bool { return false }}
	_, err := service.CreateSession(t.Context(), CreateWorkspaceSessionInput{Kind: "terminal"})
	require.ErrorContains(t, err, "Open a branch terminal")
	_, err = service.OpenWorkspaceTerminal(t.Context(), "old-session", 3, 7, 80, 24)
	require.ErrorContains(t, err, "Open a branch terminal")
}
