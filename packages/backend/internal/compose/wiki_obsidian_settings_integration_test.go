package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The real filesystem store remains in use; this barrier schedules a person edit
// after the worker has read its expected revision, before the durable write.
type obsidianRaceStore struct {
	blob.Store
	beforePut func()
}

func (s *obsidianRaceStore) Put(ctx context.Context, key, media string, data io.Reader) error {
	if s.beforePut != nil {
		edit := s.beforePut
		s.beforePut = nil
		edit()
	}
	return blob.Put(ctx, s.Store, key, media, data)
}

func TestInstallObsidianSettingsRouteWorkerPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "vaultmember", LowerUsername: "vaultmember"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark,is_public) VALUES($1,'app','app','main',false) RETURNING id`, owner.ID).Scan(&repoID))
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d}`, repoID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339Nano) + `"}`)}))
	for _, u := range []db.User{owner, member} {
		sum := sha256.Sum256([]byte(u.Username))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(sum[:]), UserID: u.ID, Username: u.Username, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	state, vault, next := t.TempDir(), t.TempDir(), t.TempDir()
	github := &rosterGitHub{roles: map[string]string{"owner": "admin"}}
	provider := httptest.NewServer(http.HandlerFunc(github.serve))
	defer provider.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
	source := &services.InstallObsidianSettings{Queries: q, StateDirectory: state, CheckOwner: members.VerifyOwner}
	setup := &services.InstallSetupService{Pool: pool, Obsidian: source}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Owners: q, Origins: middleware.FixedOrigins("http://localhost:4000"), Setup: setup})
	request := func(method, login, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost:4000/api/install", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "http://localhost:4000")
		r.Header.Set("X-CSRF-Token", "csrf")
		if strings.HasPrefix(login, "smithers_") {
			r.Header.Set("Authorization", "Bearer "+login)
		} else {
			r.AddCookie(&http.Cookie{Name: "smithers_session", Value: login})
		}
		r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	set := func(login, path string) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(map[string]any{"wiki_sync.obsidian": map[string]string{"path": path}})
		return request("PUT", login, string(raw))
	}
	rawToken := "smithers_1234567890123456789012345678901234567890"
	sum := sha256.Sum256([]byte(rawToken))
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "delegated", TokenHash: hex.EncodeToString(sum[:]), TokenLastEight: "34567890", Scopes: "read:repository,write:repository,via:claude-code", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	require.Equal(t, 403, set(rawToken, vault).Code)
	require.Equal(t, 403, set(member.Username, vault).Code)
	_, err = q.GetInstallSetting(ctx, "wiki_sync.obsidian")
	require.Error(t, err)
	w := set(owner.Username, vault)
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), vault)
	for _, body := range []string{
		`{"capacity":null}`, `{"capacity":1.5}`, `{"capacity":"2"}`,
		`{"chatgpt":null}`, `{"chatgpt":"true"}`, `{"unknown":true}`,
		`{"wiki_sync.obsidian":{"path":"/tmp","unknown":true}}`,
	} {
		refused := request("PUT", owner.Username, body)
		require.Equal(t, 400, refused.Code, refused.Body.String())
		active, loadErr := source.LoadAuthorizedWikiFolder(ctx)
		require.NoError(t, loadErr)
		require.Equal(t, vault, active.Folder)
	}
	mixed, _ := json.Marshal(map[string]any{"wiki_sync.obsidian": map[string]string{"path": next}, "parallel": 3})
	require.Equal(t, 400, request("PUT", owner.Username, string(mixed)).Code)
	require.NotContains(t, w.Body.String(), "session")
	require.Equal(t, 400, set(owner.Username, state).Code)
	require.Equal(t, 400, set(owner.Username, "/tmp").Code)
	alias := filepath.Join(t.TempDir(), "alias")
	require.NoError(t, os.Symlink(state, alias))
	require.Equal(t, 400, set(owner.Username, alias).Code)
	require.Equal(t, 400, set(owner.Username, filepath.Join(vault, "missing")).Code)
	setting, err := source.LoadAuthorizedWikiFolder(ctx)
	require.NoError(t, err)
	require.Equal(t, vault, setting.Folder)
	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://localhost:4000"})
	require.NoError(t, err)
	svc := services.NewWikiService(q, nil, services.WithWikiCollaboration(q, nil), services.WithWikiContent(store))
	markdown := "---\nunknown: retained\n---\n# Retry\n"
	marker := filepath.Join(t.TempDir(), "executed")
	helper := filepath.Join(t.TempDir(), "helper")
	require.NoError(t, os.WriteFile(helper, []byte("#!/bin/sh\ntouch "+marker+"\n"), 0700))
	cmd := exec.Command("git", "init", "-q", vault)
	require.NoError(t, cmd.Run())
	attachment := []byte{0, 1, 2, 255, 13, 10}
	require.NoError(t, os.WriteFile(filepath.Join(vault, "diagram.png"), attachment, 0600))
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Retry.md"), []byte(markdown), 0600))
	cmd = exec.Command("git", "-C", vault, "add", "Retry.md", "diagram.png")
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "-C", vault, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "-m", "fixture")
	require.NoError(t, cmd.Run())
	require.NoError(t, os.WriteFile(filepath.Join(vault, ".git", "config"), []byte("[core]\n repositoryformatversion = 0\n fsmonitor = "+helper+"\n[filter \"hostile\"]\n clean = "+helper+"\n smudge = "+helper+"\n[remote \"origin\"]\n url = ext::"+helper+"\n"), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(vault, ".gitattributes"), []byte("*.md filter=hostile\n"), 0600))
	require.NoError(t, svc.SyncInstallWikiFolder(ctx, source))
	pages, _, err := svc.ListWikiPages(ctx, &owner, owner.Username, "app", services.ListWikiPagesInput{})
	require.NoError(t, err)
	require.Len(t, pages, 2)
	slug := ""
	for _, row := range pages {
		if row.Path == "Retry.md" {
			slug = row.Slug
		}
	}
	require.NotEmpty(t, slug)
	page, err := svc.GetWikiPage(ctx, &owner, owner.Username, "app", slug)
	require.NoError(t, err)
	require.Equal(t, markdown, page.Body)
	require.Equal(t, owner.ID, page.Author.ID)
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Retry.md"), []byte(markdown+"disk\n"), 0600))
	require.NoError(t, svc.SyncInstallWikiFolder(ctx, source))
	page, err = svc.GetWikiPage(ctx, &owner, owner.Username, "app", slug)
	require.NoError(t, err)
	require.Equal(t, markdown+"disk\n", page.Body)
	body := markdown + "app\n"
	_, err = svc.UpdateWikiPage(ctx, &owner, owner.Username, "app", page.Slug, services.UpdateWikiPageInput{Body: &body, ExpectedRevision: &page.Revision})
	require.NoError(t, err)
	require.NoError(t, svc.SyncInstallWikiFolder(ctx, source))
	bytes, err := os.ReadFile(filepath.Join(vault, "Retry.md"))
	require.NoError(t, err)
	require.Equal(t, body, string(bytes))
	outside := filepath.Join(t.TempDir(), "Outside.md")
	require.NoError(t, os.WriteFile(outside, []byte("# Outside\n"), 0600))
	escape := filepath.Join(vault, "Escape.md")
	require.NoError(t, os.Symlink(outside, escape))
	require.Error(t, svc.SyncInstallWikiFolder(ctx, source))
	require.NoError(t, os.Remove(escape))
	require.NoError(t, os.Link(outside, escape))
	require.Error(t, svc.SyncInstallWikiFolder(ctx, source))
	require.NoError(t, os.Remove(escape))
	outsideBytes, err := os.ReadFile(outside)
	require.NoError(t, err)
	require.Equal(t, "# Outside\n", string(outsideBytes))
	attachmentBytes, err := os.ReadFile(filepath.Join(vault, "diagram.png"))
	require.NoError(t, err)
	require.Equal(t, attachment, attachmentBytes)
	_, err = os.Stat(marker)
	require.True(t, os.IsNotExist(err), "vault Git helpers must not execute")
	require.NoError(t, svc.SyncInstallWikiFolder(ctx, source))
	page, err = svc.GetWikiPage(ctx, &owner, owner.Username, "app", slug)
	require.NoError(t, err)
	concurrentApp := markdown + "app newer\n"
	diskEdit := markdown + "disk concurrent\n"
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Retry.md"), []byte(diskEdit), 0600))
	raced := false
	barrier := &obsidianRaceStore{Store: store}
	barrier.beforePut = func() {
		raced = true
		_, editErr := svc.UpdateWikiPage(ctx, &owner, owner.Username, "app", slug, services.UpdateWikiPageInput{Body: &concurrentApp, ExpectedRevision: &page.Revision})
		require.NoError(t, editErr)
	}
	worker := services.NewWikiService(q, nil, services.WithWikiCollaboration(q, nil), services.WithWikiContent(barrier))
	require.ErrorContains(t, worker.SyncInstallWikiFolder(ctx, source), "wiki changed")
	require.True(t, raced, "person edit must occur during the production reconciliation pass")
	page, err = svc.GetWikiPage(ctx, &owner, owner.Username, "app", slug)
	require.NoError(t, err)
	require.Equal(t, concurrentApp, page.Body)
	disk, err := os.ReadFile(filepath.Join(vault, "Retry.md"))
	require.NoError(t, err)
	require.Equal(t, diskEdit, string(disk))
	// Restore the last acknowledged disk copy; replay then exports the person edit.
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Retry.md"), []byte(body), 0600))
	require.NoError(t, svc.SyncInstallWikiFolder(ctx, source))
	disk, err = os.ReadFile(filepath.Join(vault, "Retry.md"))
	require.NoError(t, err)
	require.Equal(t, concurrentApp, string(disk))
	require.Contains(t, request("GET", owner.Username, "").Body.String(), "last_sync_at")
	require.Equal(t, 200, set(owner.Username, next).Code)
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Ignored.md"), []byte("# Ignored\n"), 0600))
	require.NoError(t, svc.SyncInstallWikiFolder(ctx, source))
	pages, _, err = svc.ListWikiPages(ctx, &owner, owner.Username, "app", services.ListWikiPagesInput{})
	require.NoError(t, err)
	require.Len(t, pages, 2)
	github.mu.Lock()
	github.roles["owner"] = "read"
	github.mu.Unlock()
	require.Error(t, svc.SyncInstallWikiFolder(ctx, source))
	github.mu.Lock()
	github.roles["owner"] = "admin"
	github.mu.Unlock()
	require.NoError(t, os.Rename(next, next+"-old"))
	require.NoError(t, os.Mkdir(next, 0700))
	require.Error(t, svc.SyncInstallWikiFolder(ctx, source))
	require.Contains(t, request("GET", owner.Username, "").Body.String(), "Obsidian sync failed")
	setup.Obsidian = nil
	require.Equal(t, 503, set(owner.Username, vault).Code)
	setup.Obsidian = source
	checkOwner := source.CheckOwner
	source.CheckOwner = nil
	require.Error(t, svc.SyncInstallWikiFolder(ctx, source))
	source.CheckOwner = checkOwner
	_, err = pool.Exec(ctx, `DELETE FROM auth_sessions WHERE user_id=$1`, owner.ID)
	require.NoError(t, err)
	require.Error(t, svc.SyncInstallWikiFolder(ctx, source))
	setup.Obsidian = nil
	w = set(owner.Username, vault)
	require.NotEqual(t, 200, w.Code)
}
