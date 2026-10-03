package seed_test

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
)

func TestCreateUserNormalizesOperatorOwner(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	id, err := seed.CreateUser(t.Context(), pool, " Alice ")
	require.NoError(t, err)
	require.Positive(t, id)
	ownerType, ownerID, err := (credits.Ledger{DB: pool}).ResolveOwner(t.Context(), "user:ALICE")
	require.NoError(t, err)
	require.Equal(t, "user", ownerType)
	require.Equal(t, id, ownerID)
	var username, lowerUsername string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT username, lower_username FROM users WHERE id = $1`, id).Scan(&username, &lowerUsername))
	require.Equal(t, "Alice", username)
	require.Equal(t, "alice", lowerUsername)
}

func TestCreateUserDuplicateReturnsErrorWithoutAnotherUser(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	id, err := seed.CreateUser(t.Context(), pool, "Alice")
	require.NoError(t, err)
	duplicateID, err := seed.CreateUser(t.Context(), pool, "ALICE")
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "23505", pgErr.Code)
	require.Zero(t, duplicateID)
	var rows int
	var persistedID int64
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*), min(id) FROM users`).Scan(&rows, &persistedID))
	require.Equal(t, 1, rows)
	require.Equal(t, id, persistedID)
}

func TestInstallOwnerRecordsOwnerAndConsumesSetupToken(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	_, err := pool.Exec(t.Context(), `INSERT INTO install_settings (key, value) VALUES ('setup_token', '{"digest":"d"}')`)
	require.NoError(t, err)
	token, err := seed.InstallOwner(t.Context(), pool, "owner", 77)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(token, "smithers_"))
	var role, login string
	var githubID int64
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT role, login, github_user_id FROM members`).Scan(&role, &login, &githubID))
	require.Equal(t, []any{"owner", "owner", int64(77)}, []any{role, login, githubID})
	var settings int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key = 'setup_token'`).Scan(&settings))
	require.Zero(t, settings)
}
