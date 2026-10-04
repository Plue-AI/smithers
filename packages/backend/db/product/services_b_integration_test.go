package product

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestServicesBProviderRefreshClaimsAndFences(t *testing.T) {
	p := servicesBDatabase(t, 0)
	servicesBRepo(t, p)
	ctx := context.Background()
	q := db.New(p)
	row, err := q.CreateProviderConnection(ctx, db.CreateProviderConnectionParams{OwnerType: "user", UserID: pgtype.Int8{Int64: 1001, Valid: true}, Provider: "codex", Kind: "oauth", AccessTokenEncrypted: []byte("old"), RefreshTokenEncrypted: []byte("refresh")})
	require.NoError(t, err)
	claim := db.ClaimProviderConnectionForRefreshParams{ExpiresBefore: time.Now().Add(time.Hour), LeaseUntil: time.Now().Add(time.Minute)}
	first, err := q.ClaimProviderConnectionForRefresh(ctx, claim)
	require.NoError(t, err)
	require.Equal(t, row.ID, first.ID)
	claim.ConnectionID = row.ID
	_, err = q.ClaimProviderConnectionForRefresh(ctx, claim)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = p.Exec(ctx, "UPDATE provider_connections SET refresh_lease_until = NOW() - interval '1 second' WHERE id=$1", row.ID)
	require.NoError(t, err)
	second, err := q.ClaimProviderConnectionForRefresh(ctx, claim)
	require.NoError(t, err)
	require.Greater(t, second.RefreshGeneration, first.RefreshGeneration)
	require.NoError(t, q.UpdateProviderConnectionTokens(ctx, db.UpdateProviderConnectionTokensParams{ID: row.ID, RefreshGeneration: second.RefreshGeneration, AccessTokenEncrypted: []byte("new"), RefreshTokenEncrypted: []byte("rotated")}))
	require.NoError(t, q.MarkProviderConnectionRefreshFailure(ctx, db.MarkProviderConnectionRefreshFailureParams{ID: row.ID, RefreshGeneration: first.RefreshGeneration, State: "revoked", LastError: "invalid_grant"}))
	require.NoError(t, q.UpdateProviderConnectionTokens(ctx, db.UpdateProviderConnectionTokensParams{ID: row.ID, RefreshGeneration: first.RefreshGeneration, AccessTokenEncrypted: []byte("stale")}))
	current, err := q.GetProviderConnection(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, "active", current.State)
	require.Equal(t, []byte("new"), current.AccessTokenEncrypted)
	require.Equal(t, []byte("rotated"), current.RefreshTokenEncrypted)
}

func TestServicesBMentionBackfillUsesUnambiguousContext(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "fresh"
		if existing {
			name = "existing_refresh_columns"
		}
		t.Run(name, func(t *testing.T) {
			p := servicesBDatabase(t, 21)
			if existing {
				_, err := p.Exec(t.Context(), `ALTER TABLE provider_connections ADD COLUMN refresh_lease_until timestamptz, ADD COLUMN refresh_generation bigint NOT NULL DEFAULT 0`)
				require.NoError(t, err)
			}
			repo := servicesBRepo(t, p)
			if existing {
				_, err := p.Exec(t.Context(), `INSERT INTO provider_connections(owner_type,user_id,provider,kind,access_token_encrypted,refresh_generation,refresh_lease_until)
			VALUES('user',1001,'codex','oauth','preserved',42,'2026-09-27T12:00:00Z')`)
				require.NoError(t, err)
			}
			ctx := context.Background()
			// Independent source sequences overlap; only the mention context is evidence.
			_, err := p.Exec(ctx, `INSERT INTO issues(id,repository_id,number,title,author_id) VALUES(7,$1,7,'issue',1001)`, repo)
			require.NoError(t, err)
			_, err = p.Exec(ctx, `INSERT INTO landing_requests(id,repository_id,number,title,author_id,target_bookmark) VALUES(7,$1,7,'landing',1001,'main')`, repo)
			require.NoError(t, err)
			_, err = p.Exec(ctx, `INSERT INTO mentions(repository_id,issue_id,comment_type,mentioned_user_id) VALUES($1,7,'issue_body',2),($1,7,'issue_body',3)`, repo)
			require.NoError(t, err)
			_, err = p.Exec(ctx, `INSERT INTO mentions(repository_id,landing_request_id,comment_type,mentioned_user_id) VALUES($1,7,'landing_body',3)`, repo)
			require.NoError(t, err)
			_, err = p.Exec(ctx, `INSERT INTO notifications(user_id,source_type,source_id) VALUES(2,'mention',7),(3,'mention',7),(1001,'mention',7)`)
			require.NoError(t, err)
			require.NoError(t, Apply(ctx, p))
			for user, want := range map[int64]string{2: "mention_issue", 3: "mention", 1001: "mention"} {
				var got string
				require.NoError(t, p.QueryRow(ctx, "SELECT source_type FROM notifications WHERE user_id=$1", user).Scan(&got))
				require.Equal(t, want, got)
			}

			require.NoError(t, Apply(ctx, p)) // Retry must preserve the original receipt and data.
			specs, err := registeredMigrations()
			require.NoError(t, err)
			var checksum string
			require.NoError(t, p.QueryRow(ctx, `SELECT checksum FROM smithers_product_migrations WHERE version=22`).Scan(&checksum))
			require.Equal(t, specs[21].checksum, checksum)
			if existing {
				var generation int64
				var lease time.Time
				var token []byte
				require.NoError(t, p.QueryRow(ctx, `SELECT refresh_generation,refresh_lease_until,access_token_encrypted FROM provider_connections WHERE user_id=1001`).Scan(&generation, &lease, &token))
				require.EqualValues(t, 42, generation)
				require.True(t, lease.Equal(time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)))
				require.Equal(t, []byte("preserved"), token)
			}
		})
	}
}

func TestProviderRefreshMigrationRejectsSchemaDrift(t *testing.T) {
	for name, ddl := range map[string]string{
		"partial":             "ADD COLUMN refresh_lease_until timestamptz",
		"wrong_type":          "ADD COLUMN refresh_lease_until timestamp, ADD COLUMN refresh_generation bigint NOT NULL DEFAULT 0",
		"wrong_default":       "ADD COLUMN refresh_lease_until timestamptz, ADD COLUMN refresh_generation bigint NOT NULL DEFAULT 1",
		"nullable_generation": "ADD COLUMN refresh_lease_until timestamptz, ADD COLUMN refresh_generation bigint DEFAULT 0",
	} {
		t.Run(name, func(t *testing.T) {
			p := servicesBDatabase(t, 21)
			_, err := p.Exec(t.Context(), "ALTER TABLE provider_connections "+ddl)
			require.NoError(t, err)
			const shape = `SELECT string_agg(a.attname || ':' || format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull || ':' || COALESCE(pg_get_expr(d.adbin,d.adrelid),''), ',' ORDER BY a.attname)
				FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
				WHERE a.attrelid='provider_connections'::regclass AND a.attname LIKE 'refresh_%' AND NOT a.attisdropped`
			var before, after string
			require.NoError(t, p.QueryRow(t.Context(), shape).Scan(&before))
			err = Apply(t.Context(), p)
			require.ErrorContains(t, err, "preexisting provider refresh columns differ")
			require.NoError(t, p.QueryRow(t.Context(), shape).Scan(&after))
			require.Equal(t, before, after)
			var latest int
			require.NoError(t, p.QueryRow(t.Context(), `SELECT max(version) FROM smithers_product_migrations`).Scan(&latest))
			require.Equal(t, 21, latest)
		})
	}
}

func servicesBDatabase(t *testing.T, version int) *pgxpool.Pool {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := context.Background()
	specs, err := registeredMigrations()
	require.NoError(t, err)
	if version > 0 {
		specs = specs[:version]
	}
	require.NoError(t, applyOnce(ctx, pool, specs))
	return pool
}
func servicesBRepo(t *testing.T, p *pgxpool.Pool) int64 {
	t.Helper()
	_, err := p.Exec(t.Context(), `INSERT INTO users(id,username,lower_username) VALUES(1001,'alice','alice'),(2,'bob','bob'),(3,'carol','carol')`)
	require.NoError(t, err)
	var id int64
	require.NoError(t, p.QueryRow(t.Context(), `INSERT INTO repositories(user_id,name,lower_name) VALUES(1001,'services-b','services-b') RETURNING id`).Scan(&id))
	return id
}
