package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockRepoConnectionRow struct {
	scanFn func(dest ...any) error
}

func (m mockRepoConnectionRow) Scan(dest ...any) error {
	// A connection lookup also scans the bound repository id.
	if len(dest) == 2 {
		if repositoryID, ok := dest[1].(*int64); ok {
			*repositoryID = testRepositoryID
		}
	}
	if m.scanFn != nil {
		return m.scanFn(dest...)
	}
	return nil
}

type mockRepoConnectionDB struct {
	execFn     func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	queryRowFn func(ctx context.Context, sql string, args ...any) pgx.Row
}

type mockGitHubRepoAccessVerifier struct {
	verifyFn func(ctx context.Context, userID int64, owner string, repo string) error
}

func (m *mockGitHubRepoAccessVerifier) VerifyUserCanPushToGitHubRepo(ctx context.Context, userID int64, owner string, repo string) (int64, error) {
	if m.verifyFn != nil {
		return testRepositoryID, m.verifyFn(ctx, userID, owner, repo)
	}
	return testRepositoryID, nil
}

func (m *mockRepoConnectionDB) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	if m.execFn != nil {
		return m.execFn(ctx, sql, arguments...)
	}
	return pgconn.NewCommandTag(""), nil
}

func (m *mockRepoConnectionDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if m.queryRowFn != nil {
		return m.queryRowFn(ctx, sql, args...)
	}
	return mockRepoConnectionRow{}
}

func TestRepoConnectionService_ConnectRepo_Success(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 4, 4, 8, 0, 0, 0, time.UTC)
	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			assert.True(t, strings.Contains(sql, "INSERT INTO repo_connections"))
			require.Len(t, args, 7)
			assert.Equal(t, int64(44), args[0])
			assert.Equal(t, "Acme", args[1])
			assert.Equal(t, "Repo", args[2])
			assert.Equal(t, "acme", args[3])
			assert.Equal(t, "repo", args[4])
			assert.Equal(t, "MIT", args[5])
			assert.Equal(t, testRepositoryID, args[6], "connect persists the verified repository id")

			return mockRepoConnectionRow{
				scanFn: func(dest ...any) error {
					*(dest[0].(*int64)) = 44
					*(dest[1].(*string)) = "Acme"
					*(dest[2].(*string)) = "Repo"
					*(dest[3].(*string)) = "MIT"
					*(dest[4].(*time.Time)) = now
					*(dest[5].(*time.Time)) = now
					return nil
				},
			}
		},
	})
	verified := false
	svc.SetGitHubRepoAccessVerifier(&mockGitHubRepoAccessVerifier{
		verifyFn: func(_ context.Context, userID int64, owner string, repo string) error {
			verified = true
			assert.Equal(t, int64(44), userID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "repo", repo)
			return nil
		},
	})

	connected, err := svc.ConnectRepo(context.Background(), 44, "Acme", "Repo", "MIT")
	require.NoError(t, err)
	assert.True(t, verified)
	assert.Equal(t, int64(44), connected.UserID)
	assert.Equal(t, "Acme", connected.Owner)
	assert.Equal(t, "Repo", connected.Repo)
	assert.Equal(t, "MIT", connected.LicenseSPDX)
}

func TestRepoConnectionService_ConnectRepo_FailsClosedWithoutVerifier(t *testing.T) {
	t.Parallel()

	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			t.Fatal("upsert must not run when no github access verifier is wired")
			return mockRepoConnectionRow{}
		},
	})

	_, err := svc.ConnectRepo(context.Background(), 44, "Acme", "Repo", "MIT")
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
}

func TestRepoConnectionService_ConnectRepo_RejectsUnverifiedGitHubAccess(t *testing.T) {
	t.Parallel()

	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			t.Fatal("upsert must not run when github access verification fails")
			return mockRepoConnectionRow{}
		},
	})
	svc.SetGitHubRepoAccessVerifier(&mockGitHubRepoAccessVerifier{
		verifyFn: func(context.Context, int64, string, string) error {
			return pkgerrors.Forbidden("your github account does not have push access to this repository")
		},
	})

	_, err := svc.ConnectRepo(context.Background(), 44, "victim-org", "private-repo", "MIT")
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 403, apiErr.Status)
}

func TestRepoConnectionService_ConnectRepo_RejectsMissingLicense(t *testing.T) {
	t.Parallel()

	svc := NewRepoConnectionService(&mockRepoConnectionDB{})
	_, err := svc.ConnectRepo(context.Background(), 1, "acme", "repo", "")
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 400, apiErr.Status)
	assert.Equal(t, "license_spdx_id is required", apiErr.Message)
}

func TestRepoConnectionService_GetRepoConnectionStatus_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			return mockRepoConnectionRow{
				scanFn: func(dest ...any) error {
					return pgx.ErrNoRows
				},
			}
		},
	})

	status, err := svc.GetRepoConnectionStatus(context.Background(), 22, "acme", "repo")
	require.NoError(t, err)
	assert.False(t, status.Connected)
	assert.Equal(t, "acme", strings.ToLower(status.Owner))
	assert.Equal(t, "repo", strings.ToLower(status.Repo))
}

func TestRepoConnectionService_DisconnectRepo_ReturnsTrueWhenDeleted(t *testing.T) {
	t.Parallel()

	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			assert.True(t, strings.Contains(sql, "DELETE FROM repo_connections"))
			require.Len(t, arguments, 3)
			assert.Equal(t, int64(100), arguments[0])
			assert.Equal(t, "acme", arguments[1])
			assert.Equal(t, "repo", arguments[2])
			return pgconn.NewCommandTag("DELETE 1"), nil
		},
	})

	deleted, err := svc.DisconnectRepo(context.Background(), 100, "Acme", "Repo")
	require.NoError(t, err)
	assert.True(t, deleted)
}
