package services

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

var identityFixtureSeq atomic.Int64

func fixtureUser(t *testing.T, pool *pgxpool.Pool, prefix string) int64 {
	t.Helper()
	n := identityFixtureSeq.Add(1)
	uname := fmt.Sprintf("%s-%d", prefix, n)
	lower := strings.ToLower(uname)
	em := lower + "@example.com"
	var id int64
	err := pool.QueryRow(context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		uname, lower, em, em, uname).Scan(&id)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(),
		`INSERT INTO email_addresses (user_id, email, lower_email, is_activated, is_primary) VALUES ($1,$2,$3,TRUE,TRUE)`,
		id, em, em)
	require.NoError(t, err)
	return id
}

func fixtureRepo(t *testing.T, pool *pgxpool.Pool, userID int64) int64 {
	t.Helper()
	n := identityFixtureSeq.Add(1)
	name := fmt.Sprintf("fixture-repo-%d", n)
	var id int64
	err := pool.QueryRow(context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1,$2,$3,'',TRUE,'main',1) RETURNING id`,
		userID, name, strings.ToLower(name)).Scan(&id)
	require.NoError(t, err)
	return id
}
