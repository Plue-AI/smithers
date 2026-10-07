package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
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
	"gopkg.in/yaml.v3"
)

func TestInstallSystemTodoReadLiteralCellsPostgres(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	ctx := t.Context()
	todos := services.NewMythicalService(f.pool, nil)
	item, err := q.GetMythicalItemByNumber(ctx, f.row.RepositoryID, 1)
	require.NoError(t, err)
	item.WorkspaceID = f.row.ID
	item.RequestRunID = uuid.NewString()
	item.Attempt = 1
	item, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte(f.cookie))
	person := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &f.user, SessionHash: hex.EncodeToString(sum[:])})
	_, err = todos.FileTodo(person, f.row.RepositoryID, f.user.ID, services.MythicalTodoInput{Title: "Other TODO canary", Prompt: "other-private-canary", Request: "other-system-read"})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = f.origin
	cfg.Server.AllowedOrigins = []string{f.origin}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}, Live: &routes.LiveHandler{Origins: func() []string { return []string{f.origin} }}})
	token := func(n int, scopes string) string {
		raw := fmt.Sprintf("smithers_%040x", 9000+n)
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: f.user.ID, Name: fmt.Sprintf("system-read-%d", n), TokenHash: hash, TokenLastEight: hash[56:], Scopes: scopes, SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return raw
	}
	runScopes := "read:repository," + middleware.RepositoryRestrictionScope(f.row.RepositoryID) + "," + middleware.LandingWorkspaceScope(f.row.ID) + "," + middleware.AgentSessionRestrictionScope(item.RequestRunID)
	run := token(1, runScopes)
	machine := token(2, "read:repository,"+middleware.RepositoryRestrictionScope(f.row.RepositoryID)+",workspace:"+f.row.ID)
	call := func(path, credential string) (int, string, []string) {
		req := httptest.NewRequest("GET", f.origin+path, nil)
		req.Header.Set("Origin", f.origin)
		req.RemoteAddr = "127.0.0.1:61000"
		req.Header.Set("Authorization", "Bearer "+credential)
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "smithers")
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out.Code, out.Body.String(), commands
	}
	// SG-07: four reviewed literal cells, with the same served read handler.
	for _, cell := range []struct {
		name, path, credential string
		status                 int
	}{
		{"RO", "/api/todos/1", run, 200}, {"RX", "/api/todos/2", run, 403},
		{"MO", "/api/todos/1", machine, 200}, {"MX", "/api/todos/2", machine, 403},
	} {
		t.Run(cell.name, func(t *testing.T) {
			status, body, commands := call(cell.path, cell.credential)
			require.Equal(t, cell.status, status, body)
			require.Equal(t, []string{"todo.read"}, commands)
			if status == 200 {
				var result map[string]any
				require.NoError(t, json.Unmarshal([]byte(body), &result))
				require.Equal(t, float64(1), result["n"])
				require.NotContains(t, body, "other-private-canary")
				for _, key := range []string{"owner", "present", "waits", "steers", "preapproval", "view_state", "confirmations"} {
					require.NotContains(t, result, key)
				}
			} else {
				require.Contains(t, body, `"code":"permission"`)
			}
		})
	}
	for _, credential := range []string{run, machine} {
		for _, path := range []string{"/api/todos", "/api/stack"} {
			status, body, _ := call(path, credential)
			require.Equal(t, 403, status, body)
			require.NotContains(t, body, "other-private-canary")
		}
	}
	// A stale run binding and a narrower file grant cannot become TODO reads.
	stale := token(3, strings.Replace(runScopes, item.RequestRunID, uuid.NewString(), 1))
	narrow := token(4, runScopes+","+strings.Join(middleware.PathRestrictionScopes([]string{"src/**"}), ","))
	// Exact parent/repository scopes do not grant a children profile TODO reads.
	children := token(5, "read:repository,read:workspace,write:workspace,"+middleware.RepositoryRestrictionScope(f.row.RepositoryID)+",workspace:"+f.row.ID+","+middleware.WorkspaceChildrenCredentialScope())
	for _, credential := range []string{stale, narrow} {
		status, body, _ := call("/api/todos/1", credential)
		require.Equal(t, 403, status, body)
	}
	t.Run("children profile has no parent TODO grant", func(t *testing.T) {
		status, body, commands := call("/api/todos/1", children)
		require.Equal(t, 403, status, body)
		require.Contains(t, body, `"code":"permission"`)
		require.Equal(t, []string{"todo.read"}, commands)
	})
	// Bound decisions cannot be reused for a different TODO number.
	runHash := sha256.Sum256([]byte(run))
	var tokenID int64
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT id FROM access_tokens WHERE token_hash=$1`, hex.EncodeToString(runHash[:])).Scan(&tokenID))
	storedToken, err := q.GetAccessTokenByID(ctx, tokenID)
	require.NoError(t, err)
	subject := services.InstallSubject{RepositoryID: f.row.RepositoryID, TodoNumber: 1}
	info := &middleware.AuthInfo{User: &f.user, TokenID: storedToken.ID, TokenHash: storedToken.TokenHash, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: runScopes, Scopes: middleware.ParseTokenScopes(runScopes)}
	bound := middleware.ContextWithAuthInfo(ctx, info)
	decision, err := services.Authorize(bound, q, "todo.read", subject)
	require.NoError(t, err)
	bound = services.WithInstallAuthorization(bound, "todo.read", decision, subject)
	_, err = services.Authorize(bound, q, "todo.read", services.InstallSubject{RepositoryID: f.row.RepositoryID, TodoNumber: 2})
	var access *services.AccessError
	require.ErrorAs(t, err, &access)
	require.Equal(t, 403, access.Status)

	t.Run("current sponsor reads a retained former-owner machine", func(t *testing.T) {
		former, err := q.CreateUser(ctx, db.CreateUserParams{Username: "former-owner", LowerUsername: "former-owner"})
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write');`, f.row.RepositoryID, former.ID)
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, f.row.ID, former.ID)
		require.NoError(t, err)
		for _, credential := range []string{run, machine} {
			status, body, commands := call("/api/todos/1", credential)
			require.Equal(t, 200, status, body)
			require.Equal(t, []string{"todo.read"}, commands)
		}
		old := *info
		old.User = &former
		_, err = services.Authorize(middleware.ContextWithAuthInfo(ctx, &old), q, "todo.read", subject)
		var access *services.AccessError
		require.ErrorAs(t, err, &access)
		require.Equal(t, 403, access.Status, "the creator does not inherit the new sponsor's read")
		var commands []string
		ctx := services.WithAuthorizationObserver(middleware.ContextWithAuthInfo(ctx, info), func(command string) { commands = append(commands, command) })
		decision, err := services.Authorize(ctx, q, "todo.read", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "todo.read", decision, subject)
		changed, err := q.GetMythicalItemByNumber(ctx, f.row.RepositoryID, 1)
		require.NoError(t, err)
		changed.OwnerID.Int64 = former.ID
		_, err = q.SaveMythicalItem(ctx, changed)
		require.NoError(t, err)
		_, err = todos.Todo(ctx, f.row.RepositoryID, 1)
		require.ErrorAs(t, err, &access)
		require.Equal(t, 403, access.Status, "a bound role decision cannot disclose a changed owner's row")
		require.Equal(t, []string{"todo.read"}, commands)
	})
}

func TestInstallSystemTodoReadOpenAPI(t *testing.T) {
	data, err := os.ReadFile(openAPIPath)
	require.NoError(t, err)
	var document yaml.Node
	require.NoError(t, yaml.Unmarshal(data, &document))
	root := document.Content[0]
	schemas := mappingValue(mappingValue(root, "components"), "schemas")
	schema := mappingValue(schemas, "TodoSystemRead")
	require.NotNil(t, schema)
	require.Equal(t, "false", mappingValue(schema, "additionalProperties").Value)
	props := mappingValue(schema, "properties")
	var names []string
	for i := 0; i < len(props.Content); i += 2 {
		names = append(names, props.Content[i].Value)
	}
	require.ElementsMatch(t, []string{"n", "title", "state", "attempt", "generation", "workspace", "run", "base"}, names)
	response := mappingValue(mappingValue(mappingValue(mappingValue(mappingValue(mappingValue(mappingValue(root, "paths"), "/api/todos/{n}"), "get"), "responses"), "200"), "content"), "application/json")
	alternatives := mappingValue(mappingValue(response, "schema"), "oneOf")
	require.Len(t, alternatives.Content, 2)
	require.Equal(t, "#/components/schemas/TodoSystemRead", mappingValue(alternatives.Content[1], "$ref").Value)
}
