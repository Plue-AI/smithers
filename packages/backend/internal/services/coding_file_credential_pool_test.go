package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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

type codingGrantCommitFailure struct{ *pgxpool.Pool }
type codingGrantFailedTransaction struct{ pgx.Tx }

var errCodingGrantCommit = errors.New("credential fixture commit failed")

func (p codingGrantCommitFailure) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return codingGrantFailedTransaction{tx}, nil
}

func (codingGrantFailedTransaction) Commit(context.Context) error { return errCodingGrantCommit }

func TestCodingFileGrantDoesNotEscapeFailedAuthorityCommit(t *testing.T) {
	f := newCodingGrantFixtureWithWorkspace(t, func(f codingGrantFixture) {
		q := db.New(f.pool)
		owner, err := q.GetBranchMachineOwner(t.Context())
		require.NoError(t, err)
		_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET user_id=$2, target_bookmark='scratch/owner/commit' WHERE id=$1`, f.workspace, owner)
		require.NoError(t, err)
		_, err = q.UpsertWorkspaceShare(t.Context(), db.UpsertWorkspaceShareParams{WorkspaceID: f.workspace, OwnerUserID: owner, GranteeUserID: f.user, Level: "write"})
		require.NoError(t, err)
	})
	f.workspaces.branchMachineProviders = branchMachineTestProviders()
	// Only commit failure is injected. Host authentication, locked authority,
	// token insertion and rollback use real PostgreSQL.
	f.workspaces.transactions = codingGrantCommitFailure{f.pool}
	grant, err := f.issuer.Mint(t.Context(), f.host, f.credential, CodingFileGrantInput{RunID: "Run-A", BatchDigest: strings.Repeat("a", 64)})
	require.ErrorIs(t, err, errCodingGrantCommit)
	require.Equal(t, CodingFileGrant{}, grant, "no bearer escapes an uncommitted authority scope")
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens WHERE name=$1`, "coding-file-"+f.host).Scan(&count))
	require.Zero(t, count, "failed authority commit must roll back credential issuance")
	require.Zero(t, f.pool.Stat().AcquiredConns())
}

func TestHeldWorkspaceMutationTransactionIsSubjectBound(t *testing.T) {
	tx := codingGrantFailedTransaction{}
	ctx := context.WithValue(t.Context(), workspaceMutationTransactionKey{}, workspaceMutationTransaction{
		authority: workspaceMutationAuthority{workspaceID: "branch-a", userID: 7}, tx: tx,
	})
	require.Equal(t, tx, heldWorkspaceMutationTransaction(ctx, "branch-a", 7))
	require.Nil(t, heldWorkspaceMutationTransaction(ctx, "branch-b", 7))
	require.Nil(t, heldWorkspaceMutationTransaction(ctx, "branch-a", 8))
	require.Nil(t, heldWorkspaceMutationTransaction(t.Context(), "branch-a", 7))
}

func TestWorkspaceAuthorityTransactionKeepsShareLockUntilSettlement(t *testing.T) {
	for _, branch := range []bool{false, true} {
		for _, succeeds := range []bool{false, true} {
			t.Run(fmt.Sprintf("branch=%t/commit=%t", branch, succeeds), func(t *testing.T) {
				pool := newProductTestPool(t)
				owner, repo := setupTestUserAndRepo(t, pool)
				q := db.New(pool)
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				defer cancel()
				if branch {
					var err error
					owner, err = q.GetBranchMachineOwner(ctx)
					require.NoError(t, err)
				}
				var writer int64
				require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('share-writer','share-writer') RETURNING id`).Scan(&writer))
				row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, Kind: "container", Status: "running", TargetBookmark: "scratch/owner/lock"})
				require.NoError(t, err)
				_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: row.ID, OwnerUserID: owner, GranteeUserID: writer, Level: "write"})
				require.NoError(t, err)
				svc := NewWorkspaceService(q, WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
				entered, release := make(chan struct{}), make(chan struct{})
				var once sync.Once
				unblock := func() { once.Do(func() { close(release) }) }
				defer unblock()
				finished := make(chan error, 1)
				errCallback := errors.New("abort authority callback")
				go func() {
					finished <- svc.withWorkspaceMutationAuthority(ctx, row, writer, func(held context.Context) error {
						tx := heldWorkspaceMutationTransaction(held, row.ID, writer)
						if tx == nil {
							return errors.New("missing held transaction")
						}
						if _, err := issueTemporaryRepoTokenWithTTL(held, db.New(tx), writer, "authority-probe", "repo", time.Minute); err != nil {
							return err
						}
						close(entered)
						select {
						case <-release:
						case <-ctx.Done():
							return ctx.Err()
						}
						if !succeeds {
							return errCallback
						}
						return nil
					})
				}()
				select {
				case <-entered:
				case err := <-finished:
					t.Fatalf("authority did not enter: %v", err)
				case <-ctx.Done():
					t.Fatal("authority did not enter before deadline")
				}
				var tokens int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE name='authority-probe'`).Scan(&tokens))
				require.Zero(t, tokens, "nested work cannot commit the outer transaction early")
				revoked := make(chan error, 1)
				go func() {
					revoked <- q.DeleteWorkspaceShare(ctx, db.DeleteWorkspaceShareParams{WorkspaceID: row.ID, GranteeUserID: writer})
				}()
				require.Eventually(t, func() bool { return shareRevocationWaiting(ctx, pool) }, 3*time.Second, 10*time.Millisecond)
				select {
				case err := <-revoked:
					t.Fatalf("revocation crossed held authority: %v", err)
				default:
				}
				unblock()
				if succeeds {
					require.NoError(t, <-finished)
				} else {
					require.ErrorIs(t, <-finished, errCallback)
				}
				require.NoError(t, <-revoked)
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE name='authority-probe'`).Scan(&tokens))
				want := 0
				if succeeds {
					want = 1
				}
				require.Equal(t, want, tokens)
				err = svc.withWorkspaceMutationAuthority(ctx, row, writer, func(context.Context) error { t.Fatal("revoked share admitted"); return nil })
				require.Error(t, err)
			})
		}
	}
}
