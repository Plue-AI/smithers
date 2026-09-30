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

// The host launches configured folder sync with its background workers.
func TestRun_SyncsConfiguredWikiFolder(t *testing.T) {
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
	require.Eventually(t, func() bool {
		var path string
		err := pool.QueryRow(ctx, `SELECT path FROM wiki_pages WHERE repository_id=$1 AND visibility='private'`, repo.ID).Scan(&path)
		return err == nil && path == "Home.md"
	}, 15*time.Second, 50*time.Millisecond, "logs:\n%s", h.logs.String())
	h.shutdownAndWaitNil()
}
