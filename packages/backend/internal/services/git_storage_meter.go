package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// GitBytesStore keeps the git object bytes repo-host measures for a
// repository after a push.
type GitBytesStore interface {
	GetRepositoryGitUsage(ctx context.Context, repositoryID int64) (db.GetRepositoryGitUsageRow, error)
	RecordRepositoryGitBytes(ctx context.Context, arg db.RecordRepositoryGitBytesParams) error
}

// GitStorageMeter is the repo-host client's PushMeter: it caps a push at its
// owner's remaining storage and records the repository's git bytes, which
// SumStorageBytesByOwner then counts (smithersai/plue#593).
type GitStorageMeter struct {
	budget StorageBudgeter
	store  GitBytesStore
}

var _ repohost.PushMeter = (*GitStorageMeter)(nil)
var _ repohost.ProvisionMeter = (*GitStorageMeter)(nil)

func NewGitStorageMeter(budget StorageBudgeter, store GitBytesStore) *GitStorageMeter {
	return &GitStorageMeter{budget: budget, store: store}
}

// gitUsageReadAttempts bounds how often GitBytesAllowance rereads a
// repository whose measurement a finished push keeps replacing.
const gitUsageReadAttempts = 3

// GitBytesAllowance is the owner's storage limit less everything the owner
// stores outside this repository's recorded git bytes: repo-host subtracts the repository's size, measured
// under the push's lock, so the repository cannot outgrow the owner's limit
// however late its last measurement was recorded. The two reads must see the
// same measurement, so the repository is read before and after the owner's
// usage and the allowance is used only when both match.
func (m *GitStorageMeter) GitBytesAllowance(ctx context.Context, repositoryID int64) (int64, bool, error) {
	for range gitUsageReadAttempts {
		before, err := m.store.GetRepositoryGitUsage(ctx, repositoryID)
		if err != nil {
			return 0, false, fmt.Errorf("read recorded git bytes: %w", err)
		}
		remaining, limited, err := m.budget.RemainingStorageBytes(ctx, repositoryID)
		if err != nil || !limited {
			return 0, limited, err
		}
		after, err := m.store.GetRepositoryGitUsage(ctx, repositoryID)
		if err != nil {
			return 0, false, fmt.Errorf("read recorded git bytes: %w", err)
		}
		if before.GitBytes == after.GitBytes && before.MeasuredAt.Equal(after.MeasuredAt) {
			return max(remaining+max(after.GitBytes, 0), 0), true, nil
		}
	}
	return 0, false, fmt.Errorf("repository %d git bytes changed on each of %d reads", repositoryID, gitUsageReadAttempts)
}

func (m *GitStorageMeter) RecordGitBytes(ctx context.Context, repositoryID, gitBytes int64, measuredAt time.Time) error {
	return m.store.RecordRepositoryGitBytes(ctx, db.RecordRepositoryGitBytesParams{
		RepositoryID: repositoryID, GitBytes: gitBytes, MeasuredAt: measuredAt,
	})
}

// provisionGitStore finds a staged repository's owner and, once the
// repository is published, its row. GitStorageMeter needs it only to meter
// staged forks and imports (smithersai/plue#768).
type provisionGitStore interface {
	GetUserByLowerUsername(context.Context, string) (db.User, error)
	GetOrgByLowerName(context.Context, string) (db.Organization, error)
	GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
}

var _ provisionGitStore = (*db.Queries)(nil)

// OwnerGitBytesAllowance is everything owner may still store: a staged
// repository has no recorded bytes to add back. An unlimited policy looks
// nothing up.
func (m *GitStorageMeter) OwnerGitBytesAllowance(ctx context.Context, owner string) (int64, bool, error) {
	if _, unlimited := m.budget.(*UnlimitedBillingPolicy); unlimited {
		return 0, false, nil
	}
	store, ok := m.store.(provisionGitStore)
	if !ok {
		return 0, false, fmt.Errorf("git storage owner lookup is unavailable")
	}
	owner = strings.ToLower(owner)
	user, err := store.GetUserByLowerUsername(ctx, owner)
	ownerType, ownerID := BillingOwnerTypeUser, user.ID
	if errors.Is(err, pgx.ErrNoRows) {
		org, orgErr := store.GetOrgByLowerName(ctx, owner)
		ownerType, ownerID, err = BillingOwnerTypeOrg, org.ID, orgErr
	}
	if err != nil {
		return 0, false, fmt.Errorf("resolve git storage owner: %w", err)
	}
	remaining, limited, err := m.budget.RemainingOwnerStorageBytes(ctx, ownerType, ownerID)
	if err != nil || !limited {
		return 0, limited, err
	}
	return max(remaining, 0), true, nil
}

// RecordProvisionedGitBytes records the git bytes of the published
// repository owner/repo under its row's ID.
func (m *GitStorageMeter) RecordProvisionedGitBytes(ctx context.Context, owner, repo string, gitBytes int64, measuredAt time.Time) error {
	store, ok := m.store.(provisionGitStore)
	if !ok {
		return fmt.Errorf("provisioned git storage lookup is unavailable")
	}
	repository, err := store.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner: strings.ToLower(owner), LowerName: strings.ToLower(repo),
	})
	if err != nil {
		return fmt.Errorf("resolve provisioned repository: %w", err)
	}
	return m.RecordGitBytes(ctx, repository.ID, gitBytes, measuredAt)
}
