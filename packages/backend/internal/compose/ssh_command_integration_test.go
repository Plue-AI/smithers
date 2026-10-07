package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Connection metadata crosses the composed install router with real auth,
// branch authorization and PostgreSQL; no daemon or wake fake supplies it.
func TestInstallSSHCommandPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ssh-owner", LowerUsername: "ssh-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"ssh-owner","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-07T00:00:00Z"}`)}))
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, Name: "retry", TargetBookmark: "scratch/ssh-owner/retry", Kind: "vm", Status: "stopped", EnvironmentSource: "repository"})
	require.NoError(t, err)
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: branch.ID, OwnerUserID: machineOwner, GranteeUserID: owner.ID, Level: "write"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, member.ID)
	require.NoError(t, err)
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: branch.ID, OwnerUserID: machineOwner, GranteeUserID: member.ID, Level: "write"})
	require.NoError(t, err)
	cookie := "ssh-command-cookie"
	sum := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: member.ID, Username: member.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://localhost:4000"
	branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, nil, &routes.WorkspaceHandler{Service: branches})
	server.Start()
	defer server.Close()
	read := func(login string, authenticated bool) (int, map[string]any) {
		request, err := http.NewRequest("GET", server.URL+"/api/ssh?branch="+url.QueryEscape(login), nil)
		require.NoError(t, err)
		if authenticated {
			request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		response, err := server.Client().Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		var body map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&body))
		return response.StatusCode, body
	}
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "public_origins", Value: []byte(`[]`)}))
	token := "smithers_" + strings.Repeat("c", 40)
	tokenSum := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(tokenSum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: member.ID, Name: "ssh-cli", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:repository,write:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	bin := t.TempDir()
	argvFile := filepath.Join(bin, "argv")
	require.NoError(t, os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > '"+argvFile+"'\nexit 7\n"), 0700))
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	invoke := catalogCLIInvoker(t, ctx, server.URL, token)
	code, receipt := invoke("ssh", "retry")
	require.Equal(t, 7, code, receipt)
	recorded, err := os.ReadFile(argvFile)
	require.NoError(t, err)
	require.Equal(t, "-p\n2222\n-l\nscratch/ssh-owner/retry\nlocalhost\n", string(recorded))
	status, line := read("retry", true)
	require.Equal(t, 200, status, line)
	require.Equal(t, "ssh -p 2222 retry@localhost", line["value"])
	require.Equal(t, "scratch/ssh-owner/retry", line["branch"])
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "public_origins", Value: []byte(`["https://factory.example:8443","https://other.example"]`)}))
	status, line = read("retry", true)
	require.Equal(t, 200, status, line)
	require.Equal(t, "ssh -p 2222 retry@factory.example", line["value"])
	code, receipt = invoke("ssh", "retry")
	require.Equal(t, 7, code, receipt)
	recorded, err = os.ReadFile(argvFile)
	require.NoError(t, err)
	require.Equal(t, "-p\n2222\n-l\nscratch/ssh-owner/retry\nfactory.example\n", string(recorded))
	for _, login := range []string{"main", "root+grant", "retry;touch /tmp/no", "missing"} {
		status, _ = read(login, true)
		require.Equal(t, 400, status, login)
	}
	status, _ = read("retry", false)
	require.Equal(t, 401, status)
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, member.ID)
	require.NoError(t, err)
	status, _ = read("retry", true)
	require.NotEqual(t, 200, status, "suspended members cannot read connection metadata")
}
