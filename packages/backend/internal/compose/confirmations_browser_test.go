package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

// Opt-in because it launches Chromium and Vite. PostgreSQL, session/CSRF auth,
// catalog dispatch, approvals, TODO effects and live transport are real. No
// browser route mocks or machine execution are involved in this control test.
func TestConfirmationsBrowserPostgres(t *testing.T) {
	if os.Getenv("SMITHERS_CONFIRMATION_BROWSER") != "1" {
		t.Skip("set SMITHERS_CONFIRMATION_BROWSER=1 for the composed browser journey")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
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
	token := "smithers_" + strings.Repeat("c", 40)
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "browser-test-codex", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: "read:repository,write:repository,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	token := credential.Token
	wikiToken := "smithers_" + strings.Repeat("d", 40)
	wikiSum := sha256.Sum256([]byte(wikiToken))
	wikiHash := hex.EncodeToString(wikiSum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "browser-wiki-agent", TokenHash: wikiHash, TokenLastEight: wikiHash[len(wikiHash)-8:], Scopes: "read:repository,write:repository,via:smithers,terminal-session:" + liveAppTurnCredentialFixture(t, pool, owner.ID) + "/1", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	_, err = q.CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: repo.ID, AuthorID: owner.ID, Slug: "confirm-delete", Title: "Delete this page", Body: "The exact page to delete", Visibility: "public"})
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_AUTH_SESSION_COOKIE_NAME", "session")
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", origin)
	api := startSplitProcess(t, Options{ChatHost: unusedChatHost{}})
	app, err := filepath.Abs("../../../../apps/app")
	require.NoError(t, err)
	command := exec.CommandContext(ctx, "bun", "e2e/real/confirm-merge.browser.ts")
	command.Dir = app
	command.Env = append(os.Environ(), "SMITHERS_CONFIRMATION_ORIGIN="+origin, "SMITHERS_CONFIRMATION_MEMBER="+fmt.Sprint(owner.ID), "SMITHERS_CONFIRMATION_TOKEN="+token, "SMITHERS_CONFIRMATION_WIKI_TOKEN="+wikiToken)
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
		if strings.HasPrefix(line, "CONFIRMATION_BROWSER_READY ") {
			vite, err = url.Parse(strings.TrimPrefix(line, "CONFIRMATION_BROWSER_READY "))
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
	var result []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_build_object('approved',count(*) FILTER (WHERE state='approved'),'pending',count(*) FILTER (WHERE state='pending')) FROM approvals`).Scan(&result))
	var counts map[string]int
	require.NoError(t, json.Unmarshal(result, &counts))
	require.Equal(t, map[string]int{"approved": 4, "pending": 0}, counts)
}
