package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Opt-in browser proof over the complete install composition. PostgreSQL,
// command dispatch, TODO cards and live replay are real; only network delivery
// is interrupted. This control-only journey does not execute repository code.
func TestLiveTodoBrowserPostgres(t *testing.T) {
	if os.Getenv("SMITHERS_LIVE_BROWSER") != "1" {
		t.Skip("set SMITHERS_LIVE_BROWSER=1 for the composed live browser journey")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	_, _, pool := splitProcessDatabase(t)
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya", DisplayName: "Maya"})
	require.NoError(t, err)
	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben", DisplayName: "Ben"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	for _, person := range []db.User{owner, other} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, person.ID)
		require.NoError(t, err)
		sum := sha256.Sum256([]byte(person.Username + "-browser-session"))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.ID, Username: person.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339Nano)))}))
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_AUTH_SESSION_COOKIE_NAME", "session")
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", origin)
	api := startSplitProcess(t, Options{ChatHost: unusedChatHost{}})
	app, err := filepath.Abs("../../../../apps/app")
	require.NoError(t, err)
	command := exec.CommandContext(ctx, "bun", "e2e/real/live-todo.browser.ts")
	command.Dir = app
	command.Env = append(os.Environ(), "SMITHERS_LIVE_ORIGIN="+origin)
	stdout, err := command.StdoutPipe()
	require.NoError(t, err)
	stdin, err := command.StdinPipe()
	require.NoError(t, err)
	command.Stderr = os.Stderr
	require.NoError(t, command.Start())
	t.Cleanup(func() { cancel(); _ = command.Process.Kill() })
	scanner := bufio.NewScanner(stdout)
	var vite *url.URL
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "LIVE_BROWSER_READY ") {
			vite, err = url.Parse(strings.TrimPrefix(line, "LIVE_BROWSER_READY "))
			require.NoError(t, err)
			break
		}
		t.Log(line)
	}
	require.NotNil(t, vite, "browser fixture did not start")
	proxy := httputil.NewSingleHostReverseProxy(vite)
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
		} else {
			proxy.ServeHTTP(w, r)
		}
	})
	server.Start()
	defer server.Close()
	_, err = fmt.Fprintln(stdin, "ready")
	require.NoError(t, err)
	_ = stdin.Close()
	for scanner.Scan() {
		t.Log(scanner.Text())
	}
	require.NoError(t, scanner.Err())
	require.NoError(t, command.Wait())
	var drops int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped'`).Scan(&drops))
	require.Equal(t, 2, drops, "both browser changes have committed source events")
}
