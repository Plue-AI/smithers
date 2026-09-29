package postgresfixture_test

import (
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func TestCreateUserNormalizesOperatorOwner(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	id, err := postgresfixture.CreateUser(t.Context(), pool, " Alice ")
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
	id, err := postgresfixture.CreateUser(t.Context(), pool, "Alice")
	require.NoError(t, err)
	duplicateID, err := postgresfixture.CreateUser(t.Context(), pool, "ALICE")
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
