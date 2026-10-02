package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"os"
	"os/exec"

	"strings"

	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// storageIdentityHas reports whether native storage holds commit sha, as an
// object or on any ref.
func storageIdentityHas(t *testing.T, gitDir, sha string) bool {
	t.Helper()
	if _, err := os.Stat(gitDir); err != nil {
		return false
	}
	object := exec.Command("git", "--git-dir", gitDir, "cat-file", "-e", sha+"^{commit}")
	if object.Run() == nil {
		return true
	}
	refs, err := exec.Command("git", "--git-dir", gitDir, "for-each-ref", "--format=%(objectname)").Output()
	require.NoError(t, err)
	return strings.Contains(string(refs), sha)
}

func storageIdentityToken(t *testing.T, q *db.Queries, userID int64) string {
	t.Helper()
	sum := sha256.Sum256([]byte("storage-identity-token"))
	token := "smithers_" + hex.EncodeToString(sum[:])[:40]
	hash := sha256.Sum256([]byte(token))
	digest := hex.EncodeToString(hash[:])
	_, err := q.CreateAccessToken(context.Background(), db.CreateAccessTokenParams{
		UserID: userID, Name: "push", TokenHash: digest, TokenLastEight: digest[len(digest)-8:],
		Scopes: "write:repository,read:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	require.NoError(t, err)
	return token
}

func storageIdentityGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	out, err := command.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}
