package services

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type repositoryAtStub struct {
	calls []db.GetRepoByOwnerAndLowerNameParams
	repo  db.Repository
	err   error
}

func (s *repositoryAtStub) GetRepoByOwnerAndLowerName(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	s.calls = append(s.calls, arg)
	return s.repo, s.err
}

func TestRepositoryStillAt(t *testing.T) {
	lookup := errors.New("database unavailable")
	for _, tc := range []struct {
		name string
		repo db.Repository
		err  error
		want error
	}{
		{name: "same repository", repo: db.Repository{ID: 7}},
		{name: "another repository took the name", repo: db.Repository{ID: 8}, want: repohost.ErrRepositoryReplaced},
		{name: "nothing has the name", err: pgx.ErrNoRows, want: repohost.ErrRepositoryReplaced},
		{name: "the lookup failed", err: lookup, want: lookup},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := &repositoryAtStub{repo: tc.repo, err: tc.err}
			err := RepositoryStillAt(stub, 7, "Alice", "Demo")(context.Background())
			if tc.want == nil {
				require.NoError(t, err)
			} else {
				require.ErrorIs(t, err, tc.want)
			}
			if tc.err == lookup {
				assert.NotErrorIs(t, err, repohost.ErrRepositoryReplaced, "a failed lookup is not evidence of replacement")
			}
			require.Equal(t, []db.GetRepoByOwnerAndLowerNameParams{{Owner: "alice", LowerName: "demo"}}, stub.calls)
		})
	}
}

// The push is checked under repo-host's lock against the repository it was
// authorized for, and a replacement is a retryable conflict (#2846).
func TestGitHTTPProxyService_ReceivePack_ChecksRepositoryUnderLock(t *testing.T) {
	for _, tc := range []struct {
		name       string
		current    int64
		wantStatus int
	}{
		{name: "unchanged", current: 109},
		{name: "replaced", current: 110, wantStatus: 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lookups := 0
			q := &mockGitHTTPProxyQuerier{
				getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
					return db.GetAuthInfoByTokenHashRow{ID: 7, Username: "alice", TokenID: 88, TokenScopes: "write:repository", IsActive: true}, nil
				},
				getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					lookups++
					assert.Equal(t, db.GetRepoByOwnerAndLowerNameParams{Owner: "alice", LowerName: "demo"}, arg)
					if lookups == 1 {
						return db.Repository{ID: 109}, nil
					}
					return db.Repository{ID: tc.current}, nil
				},
			}
			repoHost := &mockGitHTTPRepoHostClient{
				proxyReceiveFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
					require.Len(t, meta, 1)
					require.NotNil(t, meta[0].VerifyLocked)
					// What the client does once repo-host reports the lock.
					if err := meta[0].VerifyLocked(ctx); err != nil {
						return errors.Join(errors.New("receive-pack refused under the repository lock"), err)
					}
					return nil
				},
			}
			svc := NewGitHTTPProxyService(q, &mockGitHTTPAuthorizer{}, repoHost)
			err := svc.ProxyReceivePack(context.Background(), "alice", "demo", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
				bytes.NewBufferString("0000"), io.Discard)
			assert.Equal(t, 2, lookups, "authorized once, checked again under the lock")
			if tc.wantStatus == 0 {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Equal(t, tc.wantStatus, apiStatus(t, err))
			assert.Contains(t, err.Error(), "retry the push")
		})
	}
}
