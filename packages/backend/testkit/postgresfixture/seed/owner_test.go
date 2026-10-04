package seed_test

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/stretchr/testify/require"
)

func TestOwnerTokenPrerequisite(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	token, err := seed.OwnerToken(ctx, pool, "owner")
	require.NoError(t, err)
	digest := sha256.Sum256([]byte(token))
	row, err := db.New(pool).GetAuthInfoByTokenHash(ctx, hex.EncodeToString(digest[:]))
	require.NoError(t, err)
	require.Equal(t, "owner", row.Username)
	owner, err := db.New(pool).GetSelfHostOwner(ctx)
	require.NoError(t, err)
	require.Equal(t, "owner", owner.Username)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key IN ('github.repository','owner.access')`).Scan(&count))
	require.Equal(t, 2, count)
}
