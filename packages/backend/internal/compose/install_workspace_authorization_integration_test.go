package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallWorkspaceSystemActionsPostgres(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	ctx := t.Context()
	service := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = f.origin
	cfg.Server.AllowedOrigins = []string{f.origin}
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: f.pool, live: &routes.LiveHandler{Origins: func() []string { return []string{f.origin} }}, workspace: &routes.WorkspaceHandler{Service: service}})
	other, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.row.RepositoryID, UserID: f.user.ID, Name: "other", TargetBookmark: "scratch/other", Kind: "vm", Status: "running"})
	require.NoError(t, err)
	token := func(name, scopes string, system bool) string {
		raw := "smithers_" + fmt.Sprintf("%040x", len(name)+7000)
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: f.user.ID, Name: name, TokenHash: hash, TokenLastEight: hash[56:], Scopes: scopes, SystemIssued: system, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return raw
	}
	children := token("sandbox-workspace-children-"+f.row.ID, "read:repository,read:workspace,write:workspace,"+middleware.RepositoryRestrictionScope(f.row.RepositoryID)+",workspace:"+f.row.ID+","+middleware.WorkspaceChildrenCredentialScope(), true)
	head := token("head", "write:repository,workspace:"+f.row.ID, true)
	delegated := token("delegated", "write:workspace,write:repository,via:codex", true)
	call := func(method, path, credential, body string) (int, string, []string) {
		req := httptest.NewRequest(method, f.origin+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", f.origin)
		req.RemoteAddr = "127.0.0.1:61000"
		if credential != "" {
			req.Header.Set("Authorization", "Bearer "+credential)
		} else {
			req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			req.Header.Set("X-CSRF-Token", "csrf")
		}
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "smithers")
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out.Code, out.Body.String(), commands
	}
	path := "/api/repos/presence-owner/app/workspaces/" + f.row.ID
	status, body, commands := call("GET", path+"/children", children, "")
	require.Equal(t, 200, status, body)
	require.JSONEq(t, `[]`, body)
	require.Equal(t, []string{"workspace.children.list"}, commands)
	for _, cell := range []struct{ name, method, path, credential, body string }{
		{"person is not machine", "GET", path + "/children", "", ""},
		{"delegated is not machine", "GET", path + "/children", delegated, ""},
		{"head token cannot list children", "GET", path + "/children", head, ""},
		{"other parent", "GET", "/api/repos/presence-owner/app/workspaces/" + other.ID + "/children", children, ""},
		{"other repository", "GET", "/api/repos/presence-owner/absent/workspaces/" + f.row.ID + "/children", children, ""},
		{"unrelated child", "POST", path + "/children/" + other.ID + "/stop", children, `{}`},
		{"unknown child", "POST", path + "/children/" + uuid.NewString() + "/stop", children, `{}`},
		{"person cannot report head", "POST", path + "/head", "", `{}`},
		{"children cannot report head", "POST", path + "/head", children, `{}`},
		{"other workspace head", "POST", "/api/repos/presence-owner/app/workspaces/" + other.ID + "/head", head, `{}`},
	} {
		t.Run(cell.name, func(t *testing.T) {
			status, body, _ := call(cell.method, cell.path, cell.credential, cell.body)
			require.Equal(t, 403, status, body)
			require.Contains(t, body, `"code":"permission"`)
		})
	}
	row, err := q.GetWorkspace(ctx, other.ID)
	require.NoError(t, err)
	require.Equal(t, "running", row.Status, "refused stop changed another workspace")
}
