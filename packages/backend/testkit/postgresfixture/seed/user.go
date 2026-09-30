// Package seed inserts product rows for tests through the canonical product
// queries. It lives apart from postgresfixture so internal/db tests can use
// the database fixture without an import cycle.
package seed

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// CreateUser seeds a deployment test through the canonical product query.
func CreateUser(ctx context.Context, pool *pgxpool.Pool, username string) (int64, error) {
	username = strings.TrimSpace(username)
	user, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{
		Username: username, LowerUsername: strings.ToLower(username),
	})
	return user.ID, err
}
