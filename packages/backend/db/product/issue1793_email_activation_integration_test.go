package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
)

func TestIssue1793OnlyActivatedEmailIsUniqueAcrossAccounts(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	require.NoError(t, Apply(ctx, pool))

	_, err := pool.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES
		(1, 'alice', 'alice'), (2, 'bob', 'bob'), (3, 'carol', 'carol')`)
	require.NoError(t, err)

	insert := func(userID int64) int64 {
		t.Helper()
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO email_addresses (user_id, email, lower_email)
			VALUES ($1, 'Shared@Example.com', 'shared@example.com') RETURNING id`, userID).Scan(&id))
		return id
	}
	first := insert(1)
	second := insert(2)

	_, err = pool.Exec(ctx, `INSERT INTO email_addresses (user_id, email, lower_email)
		VALUES (1, 'Shared@Example.com', 'shared@example.com')`)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "email_addresses_user_id_lower_email_key", pgErr.ConstraintName)

	_, err = pool.Exec(ctx, `UPDATE email_addresses SET is_activated = true WHERE id = $1`, first)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE email_addresses SET is_activated = true WHERE id = $1`, second)
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "uq_email_addresses_activated_lower_email", pgErr.ConstraintName)

	insert(3)
	var activated int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM email_addresses
		WHERE lower_email = 'shared@example.com' AND is_activated`).Scan(&activated))
	require.Equal(t, 1, activated)
}
