package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// A single admitted grant must not wait for a second pool connection while
// retaining the first. Capability fixtures isolate connection ownership; this
// exercises real host authentication, workspace/share locks and token storage,
// not runtime qualification or concurrent editing by multiple members.
func TestCodingFileGrantFitsOneTransactionConnection(t *testing.T) {
	for _, tc := range []struct {
		name        string
		branch      bool
		connections int32
	}{
		{"owner_one_connection", false, 1},
		{"branch_two_connections", true, 2},
		{"branch_one_connection", true, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCodingGrantFixtureWithWorkspace(t, func(f codingGrantFixture) {
				if !tc.branch {
					return
				}
				q := db.New(f.pool)
				owner, err := q.GetBranchMachineOwner(t.Context())
				require.NoError(t, err)
				_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET user_id=$2, target_bookmark='scratch/owner/pool' WHERE id=$1`, f.workspace, owner)
				require.NoError(t, err)
				_, err = q.UpsertWorkspaceShare(t.Context(), db.UpsertWorkspaceShareParams{WorkspaceID: f.workspace, OwnerUserID: owner, GranteeUserID: f.user, Level: "write"})
				require.NoError(t, err)
			})
			cfg := f.pool.Config().Copy()
			cfg.MaxConns, cfg.MinConns = tc.connections, 0
			pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
			require.NoError(t, err)
			t.Cleanup(pool.Close)
			q := db.New(pool)
			auth := NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
			auth.Members = &Members{Pool: pool}
			workspaces := NewWorkspaceService(q, WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
			issuer := NewCodingFileCredentials(auth, NewFlowHostCallbacks(pool, q), workspaces)
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			grant, err := issuer.Mint(ctx, f.host, f.credential, CodingFileGrantInput{RunID: "Run-A", BatchDigest: strings.Repeat("a", 64)})
			require.NoError(t, err, "grant issuance must finish without recursively acquiring its own exhausted pool")
			require.Positive(t, grant.TokenID)
			var count int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens WHERE id=$1 AND system_issued`, grant.TokenID).Scan(&count))
			require.Equal(t, 1, count, "a returned grant must be durably committed")
			require.Zero(t, pool.Stat().AcquiredConns(), "issuance releases every held connection")
		})
	}
}
