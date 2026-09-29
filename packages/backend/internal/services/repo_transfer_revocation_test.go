package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type transferMembershipQuerier struct {
	*mockRepoQuerier
	orgMembers  []db.ListOrgMembersRow
	teamMembers map[int64][]db.User
}

func (q *transferMembershipQuerier) ListOrgMembers(_ context.Context, arg db.ListOrgMembersParams) ([]db.ListOrgMembersRow, error) {
	return page(q.orgMembers, arg.PageOffset, arg.PageSize), nil
}

func (q *transferMembershipQuerier) ListTeamMembers(_ context.Context, arg db.ListTeamMembersParams) ([]db.User, error) {
	return page(q.teamMembers[arg.TeamID], arg.PageOffset, arg.PageSize), nil
}

func transferRevocationService(t *testing.T, q RepoQuerier, base *mockRepoQuerier, repository db.Repository) (*RepoService, *recordingPublisher) {
	t.Helper()
	base.transferRepoToUserFn = func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
		return db.Repository{ID: arg.ID, UserID: arg.NewUserID, Name: repository.Name, LowerName: repository.LowerName}, nil
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "s1")
	svc.ownershipTx = &fakeOwnershipTxManager{tx: &fakeOwnershipTx{
		q:         base,
		getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil },
	}}
	publisher := &recordingPublisher{}
	svc.SetRevocationPublisher(publisher)
	return svc, publisher
}

func TestTransferRepo_RevokesThePreviousPersonalOwner(t *testing.T) {
	t.Parallel()
	repository := testRepo(nil) // owned by user 1
	base := transferQuerierToUser(repository, false)
	svc, publisher := transferRevocationService(t, base, base, repository)

	_, err := transferToBobSerialized(context.Background(), svc, &db.User{ID: 1, Username: "actor"}, repository)
	require.NoError(t, err)

	events := publisher.all()
	require.Len(t, events, 1)
	require.Equal(t, revocation.KindCollaboratorRemoved, events[0].Kind)
	require.Equal(t, int64(1), events[0].UserID)
	require.Equal(t, repository.ID, events[0].RepositoryID)
}

func TestTransferRepo_RevokesOldOrganizationOwnersAndTeamMembers(t *testing.T) {
	t.Parallel()
	repository := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{}
		r.OrgID = pgtype.Int8{Int64: 7, Valid: true}
	})
	base := transferQuerierToUser(repository, true) // actor is an org owner before the transfer
	base.listTeamReposByRepoFn = func(context.Context, int64) ([]db.TeamRepo, error) {
		return []db.TeamRepo{{TeamID: 50, RepositoryID: repository.ID}}, nil
	}
	q := &transferMembershipQuerier{
		mockRepoQuerier: base,
		orgMembers: []db.ListOrgMembersRow{
			{ID: 1, Role: "owner"},
			{ID: 3, Role: "member"}, // no team, never had access
		},
		teamMembers: map[int64][]db.User{50: {{ID: 4}, {ID: 77}}}, // 77 becomes the new owner
	}
	svc, publisher := transferRevocationService(t, q, base, repository)

	_, err := transferToBobSerialized(context.Background(), svc, &db.User{ID: 1, Username: "actor"}, repository)
	require.NoError(t, err)

	var users []int64
	for _, e := range publisher.all() {
		users = append(users, e.UserID)
	}
	require.ElementsMatch(t, []int64{1, 4}, users, "old org owner and team member lose access; the new owner keeps it")
}
