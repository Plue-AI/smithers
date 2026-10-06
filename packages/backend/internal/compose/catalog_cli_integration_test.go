package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-CAT-02: the source CLI parser and production dispatcher cross a real HTTP
// listener, delegated authorization, and PostgreSQL confirmation transactions.
func TestCatalogCLIConfirmationsPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya"})
	require.NoError(t, err)
	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo.ID))}))
	for _, u := range []db.User{owner, other} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, u.ID)
		require.NoError(t, err)
	}
	session := func(u db.User) string {
		raw := u.Username + "-confirmation-session"
		sum := sha256.Sum256([]byte(raw))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return raw
	}
	ownerCookie := session(owner)
	token := "smithers_" + strings.Repeat("c", 40)
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "cli", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: "read:repository,write:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}

	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	require.NoError(t, err)
	todos := services.NewMythicalService(pool, nil)
	approvals := services.NewApprovalsService(q, services.WithConfirmationTodos(pool, todos))
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}, Confirmations: approvals})
	server.Config.Handler = router
	server.Start()
	defer server.Close()
	cli, err := filepath.Abs("../../../smithers/src/Cli.ts")
	require.NoError(t, err)
	home := t.TempDir()
	invoke := func(argv ...string) (int, map[string]any) {
		t.Helper()
		encoded, err := json.Marshal(append(argv, "--json"))
		require.NoError(t, err)
		script := `import { pathToFileURL } from "node:url";
const { makeCli } = await import(pathToFileURL(process.env.CATALOG_CLI).href);
let stdout = "", code = 0;
await makeCli({ environment: process.env, exit: n => { code = n } }).serve(JSON.parse(process.env.CATALOG_ARGV), {
 env: process.env, stdout: text => { stdout += text }, exit: n => { code = n }
});
console.log(JSON.stringify({ code, result: JSON.parse(stdout) }));`
		command := exec.CommandContext(ctx, "node", "--no-warnings", "--input-type=module")
		command.Stdin = strings.NewReader(script)
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "XDG_CONFIG_HOME=" + home, "XDG_DATA_HOME=" + home,
			"CATALOG_CLI=" + cli, "CATALOG_ARGV=" + string(encoded), "SMITHERS_API_ORIGIN=" + server.URL, "SMITHERS_TOKEN=" + token, "CODEX_TEST=1"}
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		var response struct {
			Code   int            `json:"code"`
			Result map[string]any `json:"result"`
		}
		require.NoError(t, json.Unmarshal(output, &response), string(output))
		return response.Code, response.Result
	}
	code, receipt := invoke("todo", "new", "--text", "Keep the exact delegated request", "--title", "Retry", "--idempotencyKey", "catalog-new")
	require.Equal(t, 3, code, receipt)
	require.Equal(t, "pending", receipt["state"])
	require.Equal(t, "Waiting for maya to confirm", receipt["message"])
	id, ok := receipt["confirmation"].(string)
	require.True(t, ok, receipt)
	replayCode, replay := invoke("todo", "new", "--text", "Keep the exact delegated request", "--title", "Retry", "--idempotencyKey", "catalog-new")
	require.Equal(t, 3, replayCode)
	require.Equal(t, receipt, replay)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
	require.Zero(t, count, "CLI launch must not execute the confirmed operation")
	// Only the person's browser session can approve the same stored request.
	approve := func(confirmation, key string) {
		t.Helper()
		r := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/confirmations/"+confirmation+"/approve", strings.NewReader(`{}`))
		r.RemoteAddr = "127.0.0.1:51900"
		r.Header.Set("Origin", cfg.Server.PublicURL)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", key)
		r.Header.Set("X-CSRF-Token", "csrf")
		r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		r.AddCookie(&http.Cookie{Name: "session", Value: ownerCookie})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		require.Equal(t, 200, w.Code, w.Body.String())
	}
	approve(id, "catalog-approve")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
	require.Equal(t, 1, count)
	var number int64
	var prompt string
	require.NoError(t, pool.QueryRow(ctx, `SELECT number,issue_body FROM mythical_items`).Scan(&number, &prompt))
	require.Equal(t, "Keep the exact delegated request", prompt)
	code, receipt = invoke("todo", "show", fmt.Sprintf("T%d", number))
	require.Equal(t, 0, code, receipt)
	code, receipt = invoke("todo", "drop", fmt.Sprintf("T%d", number))
	require.Equal(t, 3, code, receipt)
	require.Equal(t, "pending", receipt["state"])
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items`).Scan(&state))
	require.Equal(t, "queued", state)
	// The placement consumer has landed: preserve --before through the
	// source CLI and private confirmation, with no item before the press.
	code, receipt = invoke("todo", "new", "--text", "Before the first item", "--before", fmt.Sprintf("T%d", number), "--idempotencyKey", "catalog-before")
	require.Equal(t, 3, code, receipt)
	require.Equal(t, "pending", receipt["state"])
	beforeID, ok := receipt["confirmation"].(string)
	require.True(t, ok, receipt)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
	require.Equal(t, 1, count)
	code, replay = invoke("todo", "new", "--text", "Before the first item", "--before", fmt.Sprintf("T%d", number), "--idempotencyKey", "catalog-before")
	require.Equal(t, 3, code, replay)
	require.Equal(t, receipt, replay)
	approve(beforeID, "catalog-before-approve")
	var placed int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT number FROM mythical_items WHERE issue_body=$1`, "Before the first item").Scan(&placed))
	var order []int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT array_agg(number ORDER BY stack_position) FROM mythical_items WHERE repository_id=$1`, repo.ID).Scan(&order))
	require.Equal(t, []int64{placed, number}, order, "the approved TODO must precede its named item, not append")
	approve(beforeID, "catalog-before-approve")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
	require.Equal(t, 2, count, "a repeated approval must not create another item")
	// Missing merge evidence is never fabricated into pending or success.
	code, receipt = invoke("merge", fmt.Sprintf("T%d", number), "--reviewed_head_sha", strings.Repeat("a", 40))
	require.Equal(t, 1, code, receipt)
	require.Equal(t, "confirmation_unavailable", receipt["code"])
	require.NotContains(t, receipt, "confirmation")
	code, receipt = invoke("debug", "api")
	require.Equal(t, 1, code, receipt)
	require.Equal(t, "never", receipt["code"])
}
