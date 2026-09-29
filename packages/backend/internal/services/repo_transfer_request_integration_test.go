package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type transferRequestFixture struct {
	pool        *pgxpool.Pool
	svc         *RepoService
	sender      *db.User
	recipient   *db.User
	bystander   *db.User
	repoID      int64
	repoName    string
	moves       []repohost.StagedMove
	moveErr     error
	rollbackErr error
	prepares    int
	finalizes   int
	rollbacks   int
}

func newTransferRequestFixture(t *testing.T) *transferRequestFixture {
	t.Helper()
	pool := getAgentTestPool(t)
	f := &transferRequestFixture{pool: pool, repoName: "transfer-" + uuid.NewString()}
	f.sender = f.user(t, "sender")
	f.recipient = f.user(t, "recipient")
	f.bystander = f.user(t, "bystander")
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark)
		VALUES ($1, $2, $2, '', TRUE, 'main') RETURNING id
	`, f.sender.ID, f.repoName).Scan(&f.repoID))
	host := &preparedRepoHost{
		mockRepoHostClient: &mockRepoHostClient{
			finalizeMoveRepoFn: func(_ context.Context, staged repohost.StagedMove) error {
				f.finalizes++
				return nil
			},
			rollbackMoveRepoFn: func(_ context.Context, staged repohost.StagedMove) error {
				f.rollbacks++
				return f.rollbackErr
			},
		},
		prepareMoveFn: func(_ context.Context, sourceOwner, sourceName, targetOwner, targetName string) (repohost.StagedMove, error) {
			f.prepares++
			return repohost.StagedMove{
				BaseURL: "http://repo-host.test", StorageRouteKey: "static",
				Token:    strings.Repeat(fmt.Sprintf("%x", f.prepares), 64),
				SrcOwner: sourceOwner, SrcRepo: sourceName,
				DstOwner: targetOwner, DstRepo: targetName,
			}, nil
		},
		executeMoveFn: func(_ context.Context, staged repohost.StagedMove) error {
			f.moves = append(f.moves, staged)
			return f.moveErr
		},
	}
	f.svc = NewProductRepoServiceWithPool(db.New(pool), host, pool)
	return f
}

func (f *transferRequestFixture) user(t *testing.T, role string) *db.User {
	t.Helper()
	name := "transfer-" + role + "-" + uuid.NewString()
	var id int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `
		INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1, $1, $2, $2, $1) RETURNING id
	`, name, name+"@example.test").Scan(&id))
	return &db.User{ID: id, Username: name, LowerUsername: name}
}

func (f *transferRequestFixture) ownerID(t *testing.T) int64 {
	t.Helper()
	var ownerID int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT user_id FROM repositories WHERE id=$1`, f.repoID).Scan(&ownerID))
	return ownerID
}

func (f *transferRequestFixture) status(t *testing.T, requestID int64) string {
	t.Helper()
	var status string
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT status FROM repository_transfer_requests WHERE id=$1`, requestID).Scan(&status))
	return status
}

func (f *transferRequestFixture) request(t *testing.T) int64 {
	t.Helper()
	result, err := f.svc.TransferRepo(context.Background(), f.sender, f.sender.Username, f.repoName, f.recipient.Username)
	require.NoError(t, err)
	require.Equal(t, f.repoID, result.ID)
	require.Equal(t, f.sender.ID, result.UserID.Int64)
	require.NotNil(t, result.PendingTransfer)
	require.Equal(t, f.repoID, result.PendingTransfer.RepositoryID)
	require.Equal(t, f.sender.ID, result.PendingTransfer.SenderID)
	require.Equal(t, f.recipient.ID, result.PendingTransfer.RecipientID)
	require.Equal(t, "pending", result.PendingTransfer.Status)
	require.WithinDuration(t, result.PendingTransfer.CreatedAt.Add(7*24*time.Hour), result.PendingTransfer.ExpiresAt, time.Second)
	return result.PendingTransfer.ID
}

func TestRepoTransferRequestIntegration_AcceptMovesOwnershipAndRevokesGrants(t *testing.T) {
	f := newTransferRequestFixture(t)
	ctx := context.Background()
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators (repository_id,user_id,permission) VALUES ($1,$2,'admin')`, f.repoID, f.bystander.ID)
	require.NoError(t, err)

	id := f.request(t)
	require.Equal(t, f.sender.ID, f.ownerID(t))
	require.Zero(t, f.prepares, "requesting consent must not prepare storage")
	require.Empty(t, f.moves, "requesting consent must not move storage")
	var collaborators int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM collaborators WHERE repository_id=$1`, f.repoID).Scan(&collaborators))
	require.Equal(t, 1, collaborators)
	var operations int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM repository_storage_operations WHERE repository_id=$1`, f.repoID).Scan(&operations))
	require.Zero(t, operations)

	visible, err := f.svc.ListRepoTransfers(ctx, f.recipient)
	require.NoError(t, err)
	require.Len(t, visible, 1)
	require.Equal(t, id, visible[0].ID)
	senderRows, err := f.svc.ListRepoTransfers(ctx, f.sender)
	require.NoError(t, err)
	require.Len(t, senderRows, 1)
	require.Equal(t, id, senderRows[0].ID)
	bystanderRows, err := f.svc.ListRepoTransfers(ctx, f.bystander)
	require.NoError(t, err)
	require.Empty(t, bystanderRows)

	_, err = f.svc.AcceptRepoTransfer(ctx, f.bystander, id)
	require.Error(t, err)
	require.Equal(t, f.sender.ID, f.ownerID(t))
	require.Equal(t, "pending", f.status(t, id))
	require.Empty(t, f.moves)

	updated, err := f.svc.AcceptRepoTransfer(ctx, f.recipient, id)
	require.NoError(t, err)
	require.Equal(t, f.repoID, updated.ID)
	require.Equal(t, f.recipient.ID, updated.UserID.Int64)
	require.Equal(t, f.recipient.ID, f.ownerID(t))
	require.Equal(t, "accepted", f.status(t, id))
	require.Len(t, f.moves, 1)
	require.Equal(t, f.sender.Username, f.moves[0].SrcOwner)
	require.Equal(t, f.recipient.Username, f.moves[0].DstOwner)
	require.Equal(t, 1, f.finalizes)
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM collaborators WHERE repository_id=$1`, f.repoID).Scan(&collaborators))
	require.Zero(t, collaborators)
	visible, err = f.svc.ListRepoTransfers(ctx, f.recipient)
	require.NoError(t, err)
	require.Empty(t, visible)
	_, err = f.svc.AcceptRepoTransfer(ctx, f.recipient, id)
	require.Error(t, err, "an accepted request cannot move storage twice")
	require.Len(t, f.moves, 1)
}

func TestRepoTransferRequestIntegration_DeclineAndCancelLeaveRepositoryUntouched(t *testing.T) {
	for _, action := range []string{"decline", "cancel"} {
		t.Run(action, func(t *testing.T) {
			f := newTransferRequestFixture(t)
			id := f.request(t)
			ctx := context.Background()
			var err error
			if action == "decline" {
				err = f.svc.DeclineRepoTransfer(ctx, f.recipient, id)
			} else {
				err = f.svc.CancelRepoTransfer(ctx, f.sender, id)
			}
			require.NoError(t, err)
			wantStatus := "declined"
			if action == "cancel" {
				wantStatus = "cancelled"
			}
			require.Equal(t, wantStatus, f.status(t, id))
			require.Equal(t, f.sender.ID, f.ownerID(t))
			require.Zero(t, f.prepares)
			require.Empty(t, f.moves)
			_, err = f.svc.AcceptRepoTransfer(ctx, f.recipient, id)
			require.Error(t, err)
		})
	}
}

func TestRepoTransferRequestIntegration_StorageFailureLeavesConsentRetryable(t *testing.T) {
	f := newTransferRequestFixture(t)
	id := f.request(t)
	f.moveErr = errors.New("storage unavailable")
	_, err := f.svc.AcceptRepoTransfer(context.Background(), f.recipient, id)
	require.Error(t, err)
	require.Equal(t, f.sender.ID, f.ownerID(t))
	require.Equal(t, "pending", f.status(t, id))
	f.moveErr = nil
	updated, err := f.svc.AcceptRepoTransfer(context.Background(), f.recipient, id)
	require.NoError(t, err)
	require.Equal(t, f.recipient.ID, updated.UserID.Int64)
	require.Equal(t, "accepted", f.status(t, id))
}

func TestRepoTransferRequestIntegration_OnePendingRequestPerRepository(t *testing.T) {
	f := newTransferRequestFixture(t)
	id := f.request(t)
	result, err := f.svc.TransferRepo(context.Background(), f.sender, f.sender.Username, f.repoName, f.recipient.Username)
	require.NoError(t, err)
	require.NotNil(t, result.PendingTransfer)
	require.Equal(t, id, result.PendingTransfer.ID)
	_, err = f.svc.TransferRepo(context.Background(), f.sender, f.sender.Username, f.repoName, f.bystander.Username)
	require.Error(t, err)
	require.Equal(t, 409, httpStatus(err))
	var pending int
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT count(*) FROM repository_transfer_requests WHERE repository_id=$1 AND status='pending'`, f.repoID).Scan(&pending))
	require.Equal(t, 1, pending)
	require.Equal(t, f.sender.ID, f.ownerID(t))
	require.Zero(t, f.prepares)
}

func TestRepoTransferRequestIntegration_RecipientNameCollisionAtAcceptance(t *testing.T) {
	f := newTransferRequestFixture(t)
	id := f.request(t)
	_, err := f.pool.Exec(context.Background(), `
		INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark)
		VALUES ($1, $2, $2, '', TRUE, 'main')
	`, f.recipient.ID, f.repoName)
	require.NoError(t, err)
	_, err = f.svc.AcceptRepoTransfer(context.Background(), f.recipient, id)
	require.Error(t, err)
	require.Equal(t, 409, httpStatus(err))
	require.Equal(t, "pending", f.status(t, id))
	require.Equal(t, f.sender.ID, f.ownerID(t))
	require.Empty(t, f.moves)
}

func TestRepoTransferRequestIntegration_AcceptAndDeclineRaceHasOneWinner(t *testing.T) {
	f := newTransferRequestFixture(t)
	id := f.request(t)
	start := make(chan struct{})
	accepted := make(chan error, 1)
	declined := make(chan error, 1)
	go func() {
		<-start
		_, err := f.svc.AcceptRepoTransfer(context.Background(), f.recipient, id)
		accepted <- err
	}()
	go func() {
		<-start
		declined <- f.svc.DeclineRepoTransfer(context.Background(), f.recipient, id)
	}()
	close(start)
	acceptErr, declineErr := <-accepted, <-declined
	require.NotEqual(t, acceptErr == nil, declineErr == nil, "exactly one terminal decision must commit")
	switch f.status(t, id) {
	case "accepted":
		require.NoError(t, acceptErr)
		require.Error(t, declineErr)
		require.Equal(t, f.recipient.ID, f.ownerID(t))
		require.Len(t, f.moves, 1)
	case "declined":
		require.Error(t, acceptErr)
		require.NoError(t, declineErr)
		require.Equal(t, f.sender.ID, f.ownerID(t))
		require.Empty(t, f.moves)
	default:
		t.Fatalf("request did not reach a terminal state")
	}
}

func TestRepoTransferRequestIntegration_ExpiryLeavesRepositoryUntouched(t *testing.T) {
	f := newTransferRequestFixture(t)
	id := f.request(t)
	f.rollbackErr = errors.New("rollback unavailable")
	ctx := context.Background()
	_, err := f.pool.Exec(ctx, `UPDATE repository_transfer_requests SET created_at=clock_timestamp()-interval '8 days', expires_at=clock_timestamp()-interval '1 day' WHERE id=$1`, id)
	require.NoError(t, err)
	visible, err := f.svc.ListRepoTransfers(ctx, f.recipient)
	require.NoError(t, err)
	require.Empty(t, visible)
	_, err = f.svc.AcceptRepoTransfer(ctx, f.recipient, id)
	require.Error(t, err)
	require.Equal(t, "expired", f.status(t, id))
	require.Equal(t, f.sender.ID, f.ownerID(t))
	require.Empty(t, f.moves)
	require.Zero(t, f.rollbacks, "expired consent must fail before any storage mutation")
	var operations int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM repository_storage_operations WHERE repository_id=$1`, f.repoID).Scan(&operations))
	require.Zero(t, operations)
	newRequest := f.request(t)
	require.NotEqual(t, id, newRequest)
}

func TestRepoTransferRequestIntegration_OrganizationTransferCancelsPendingUserConsent(t *testing.T) {
	f := newTransferRequestFixture(t)
	ctx := context.Background()
	pendingID := f.request(t)
	orgName := "transfer-org-" + uuid.NewString()
	var orgID int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO organizations (name, lower_name, description) VALUES ($1, $1, '') RETURNING id`, orgName).Scan(&orgID))
	_, err := f.pool.Exec(ctx, `INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, orgID, f.sender.ID)
	require.NoError(t, err)
	result, err := f.svc.TransferRepo(ctx, f.sender, f.sender.Username, f.repoName, orgName)
	require.NoError(t, err)
	require.Nil(t, result.PendingTransfer)
	require.Equal(t, orgName, result.Owner)
	require.True(t, result.OrgID.Valid)
	require.Equal(t, orgID, result.OrgID.Int64)
	require.False(t, result.UserID.Valid)
	require.Len(t, f.moves, 1)
	require.Equal(t, orgName, f.moves[0].DstOwner)
	require.Equal(t, "cancelled", f.status(t, pendingID))
	_, err = f.svc.AcceptRepoTransfer(ctx, f.recipient, pendingID)
	require.Error(t, err)
	var requestCount int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM repository_transfer_requests WHERE repository_id=$1 AND status='pending'`, f.repoID).Scan(&requestCount))
	require.Zero(t, requestCount)
}

func TestRepoTransferRequestIntegration_CurrentOrgOwnerCanCancelAfterSenderLosesRole(t *testing.T) {
	f := newTransferRequestFixture(t)
	ctx := context.Background()
	orgName := "transfer-org-" + uuid.NewString()
	var orgID int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO organizations (name, lower_name, description) VALUES ($1, $1, '') RETURNING id`, orgName).Scan(&orgID))
	for _, owner := range []*db.User{f.sender, f.bystander} {
		_, err := f.pool.Exec(ctx, `INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, orgID, owner.ID)
		require.NoError(t, err)
	}
	_, err := f.svc.TransferRepo(ctx, f.sender, f.sender.Username, f.repoName, orgName)
	require.NoError(t, err)
	result, err := f.svc.TransferRepo(ctx, f.sender, orgName, f.repoName, f.recipient.Username)
	require.NoError(t, err)
	require.NotNil(t, result.PendingTransfer)
	id := result.PendingTransfer.ID
	_, err = f.pool.Exec(ctx, `DELETE FROM org_members WHERE organization_id=$1 AND user_id=$2`, orgID, f.sender.ID)
	require.NoError(t, err)
	_, err = f.svc.AcceptRepoTransfer(ctx, f.recipient, id)
	require.Error(t, err)
	require.Equal(t, 403, httpStatus(err))
	require.Equal(t, "pending", f.status(t, id))
	var currentOrgID int64
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT org_id FROM repositories WHERE id=$1`, f.repoID).Scan(&currentOrgID))
	require.Equal(t, orgID, currentOrgID)
	require.Len(t, f.moves, 1, "rejected acceptance must not move storage")
	_, err = f.svc.TransferRepo(ctx, f.sender, orgName, f.repoName, f.recipient.Username)
	require.Error(t, err)
	require.Error(t, f.svc.CancelRepoTransfer(ctx, f.sender, id))
	rows, err := f.svc.ListRepoTransfers(ctx, f.sender)
	require.NoError(t, err)
	require.Empty(t, rows)
	rows, err = f.svc.ListRepoTransfers(ctx, f.bystander)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, id, rows[0].ID)
	require.NoError(t, f.svc.CancelRepoTransfer(ctx, f.bystander, id))
	require.Equal(t, "cancelled", f.status(t, id))
	result, err = f.svc.TransferRepo(ctx, f.bystander, orgName, f.repoName, f.recipient.Username)
	require.NoError(t, err)
	require.NotNil(t, result.PendingTransfer)
	require.NotEqual(t, id, result.PendingTransfer.ID)
}
