package compose

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// A single-owner install never syncs folders named in host configuration:
// 74897cf4e6 removed that fallback, so only the owner's persisted install
// setting (services.RunInstallWikiFolderSync) or a hosted deployment's
// configuration starts folder sync.
func TestRun_InstallIgnoresHostConfiguredWikiFolder(t *testing.T) {
	preserveSlog(t)
	env := baseRunEnv(t)
	ctx := context.Background()
	pool, err := postgresfixture.Open(ctx, env["SMITHERS_DATABASE_URL"], 2)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	name := fmt.Sprintf("vault-%d", time.Now().UnixNano())
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "notes", LowerName: "notes", DefaultBookmark: "main"})
	require.NoError(t, err)
	vault := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Home.md"), []byte("# Home\n"), 0o600))
	file := filepath.Join(t.TempDir(), "config.yaml")
	require.NoError(t, os.WriteFile(file, []byte(fmt.Sprintf(`feature_flags:
  wiki: true
wiki_sync:
  interval_seconds: 1
  obsidian:
    - {owner: %s, repo: notes, login: %s, visibility: private, connection: vault, folder: %q}
`, name, name, vault)), 0o600))

	h := startRun(t, env, "-config", file)
	// Three of the configured one-second passes.
	time.Sleep(3 * time.Second)
	var pages int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_pages WHERE repository_id=$1`, repo.ID).Scan(&pages))
	require.Zero(t, pages, "logs:\n%s", h.logs.String())
	h.shutdownAndWaitNil()
}
