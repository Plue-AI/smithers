package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// fakeChangesetQueries is an in-memory ChangesetQuerier.
type fakeChangesetQueries struct {
	org         db.Organization
	members     map[int64]bool // user ids that are org members
	repos       map[string]db.Repository
	changesets  map[int64]db.Changeset
	csMembers   map[int64][]db.ChangesetMember
	permissions map[int64]string
	rules       map[int64][]db.ProtectedBookmark
	// landings is each change's latest landing request, by change id.
	landings map[string]db.LandingRequest
	nextID   int64
}

func newFakeChangesetQueries() *fakeChangesetQueries {
	q := &fakeChangesetQueries{
		org:        db.Organization{ID: 7, Name: "acme", LowerName: "acme"},
		members:    map[int64]bool{1: true},
		repos:      map[string]db.Repository{},
		changesets: map[int64]db.Changeset{},
		csMembers:  map[int64][]db.ChangesetMember{},
		nextID:     100,
	}
	q.repos["api"] = db.Repository{ID: 11, Name: "api", LowerName: "api", OrgID: pgtype.Int8{Int64: 7, Valid: true}}
	q.repos["web"] = db.Repository{ID: 12, Name: "web", LowerName: "web", OrgID: pgtype.Int8{Int64: 7, Valid: true}}
	q.repos[OrgSuperprojectRepoName] = db.Repository{ID: 13, Name: OrgSuperprojectRepoName, LowerName: OrgSuperprojectRepoName, OrgID: pgtype.Int8{Int64: 7, Valid: true}}
	return q
}

func (q *fakeChangesetQueries) IsOrgOwnerForRepoUser(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, nil
}
func (q *fakeChangesetQueries) GetHighestTeamPermissionForRepoUser(_ context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if q.permissions == nil {
		return "write", nil
	}
	return q.permissions[arg.RepositoryID], nil
}
func (q *fakeChangesetQueries) GetCollaboratorPermissionForRepoUser(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return "", nil
}
func (q *fakeChangesetQueries) ListAllProtectedBookmarksByRepo(_ context.Context, id int64) ([]db.ProtectedBookmark, error) {
	return q.rules[id], nil
}
func (q *fakeChangesetQueries) GetLatestLandingRequestForChange(_ context.Context, arg db.GetLatestLandingRequestForChangeParams) (db.LandingRequest, error) {
	if lr, ok := q.landings[arg.ChangeID]; ok {
		return lr, nil
	}
	return db.LandingRequest{}, pgx.ErrNoRows
}
func (q *fakeChangesetQueries) GetLandingRequestWithChangeIDsByNumber(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
	return db.GetLandingRequestWithChangeIDsByNumberRow{}, pgx.ErrNoRows
}
func (q *fakeChangesetQueries) CreateChangesetWithMembers(ctx context.Context, arg db.CreateChangesetWithMembersParams) (db.CreateChangesetWithMembersRow, error) {
	var members []db.AddChangesetMemberParams
	if err := json.Unmarshal(arg.Members, &members); err != nil {
		return db.CreateChangesetWithMembersRow{}, err
	}
	cs, err := q.CreateChangeset(ctx, db.CreateChangesetParams{OrganizationID: arg.OrganizationID, SuperprojectRepositoryID: arg.SuperprojectRepositoryID, ChangeID: arg.ChangeID, CommitID: arg.CommitID, ParentChangeIds: arg.ParentChangeIds, TargetBookmark: arg.TargetBookmark, Description: arg.Description, CreatedBy: arg.CreatedBy})
	if err != nil {
		return db.CreateChangesetWithMembersRow{}, err
	}
	for _, m := range members {
		m.ChangesetID = cs.ID
		_, _ = q.AddChangesetMember(ctx, m)
	}
	return db.CreateChangesetWithMembersRow(cs), nil
}

func (q *fakeChangesetQueries) GetOrgByLowerName(_ context.Context, lowerName string) (db.Organization, error) {
	if lowerName != q.org.LowerName {
		return db.Organization{}, pgx.ErrNoRows
	}
	return q.org, nil
}

func (q *fakeChangesetQueries) GetOrgByID(_ context.Context, id int64) (db.Organization, error) {
	if id != q.org.ID {
		return db.Organization{}, pgx.ErrNoRows
	}
	return q.org, nil
}

func (q *fakeChangesetQueries) GetOrgMember(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
	if arg.OrganizationID != q.org.ID || !q.members[arg.UserID] {
		return db.OrgMember{}, pgx.ErrNoRows
	}
	return db.OrgMember{OrganizationID: arg.OrganizationID, UserID: arg.UserID, Role: "member"}, nil
}

func (q *fakeChangesetQueries) GetRepoByOwnerAndLowerName(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if !strings.EqualFold(arg.Owner, q.org.Name) {
		return db.Repository{}, pgx.ErrNoRows
	}
	repo, ok := q.repos[arg.LowerName]
	if !ok {
		return db.Repository{}, pgx.ErrNoRows
	}
	return repo, nil
}

func (q *fakeChangesetQueries) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	for _, repo := range q.repos {
		if repo.ID == id {
			return repo, nil
		}
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (q *fakeChangesetQueries) CreateChangeset(_ context.Context, arg db.CreateChangesetParams) (db.Changeset, error) {
	q.nextID++
	cs := db.Changeset{
		ID:                       q.nextID,
		OrganizationID:           arg.OrganizationID,
		SuperprojectRepositoryID: arg.SuperprojectRepositoryID,
		ChangeID:                 arg.ChangeID,
		CommitID:                 arg.CommitID,
		ParentChangeIds:          arg.ParentChangeIds,
		TargetBookmark:           arg.TargetBookmark,
		Description:              arg.Description,
		State:                    changesetStatePending,
		CreatedBy:                arg.CreatedBy,
	}
	q.changesets[cs.ID] = cs
	return cs, nil
}

func (q *fakeChangesetQueries) AddChangesetMember(_ context.Context, arg db.AddChangesetMemberParams) (db.ChangesetMember, error) {
	q.nextID++
	m := db.ChangesetMember{ID: q.nextID, ChangesetID: arg.ChangesetID, RepositoryID: arg.RepositoryID, Path: arg.Path, ChangeID: arg.ChangeID, CommitID: arg.CommitID, TargetBookmark: arg.TargetBookmark}
	q.csMembers[arg.ChangesetID] = append(q.csMembers[arg.ChangesetID], m)
	return m, nil
}

func (q *fakeChangesetQueries) GetChangesetByID(_ context.Context, id int64) (db.Changeset, error) {
	cs, ok := q.changesets[id]
	if !ok {
		return db.Changeset{}, pgx.ErrNoRows
	}
	return cs, nil
}

func (q *fakeChangesetQueries) GetChangesetByOrgAndID(_ context.Context, arg db.GetChangesetByOrgAndIDParams) (db.Changeset, error) {
	cs, ok := q.changesets[arg.ID]
	if !ok || cs.OrganizationID != arg.OrganizationID {
		return db.Changeset{}, pgx.ErrNoRows
	}
	return cs, nil
}

func (q *fakeChangesetQueries) ListChangesetMembers(_ context.Context, changesetID int64) ([]db.ChangesetMember, error) {
	out := append([]db.ChangesetMember(nil), q.csMembers[changesetID]...)
	return out, nil
}

func (q *fakeChangesetQueries) ListChangesetsByOrg(_ context.Context, arg db.ListChangesetsByOrgParams) ([]db.Changeset, error) {
	var out []db.Changeset
	for _, cs := range q.changesets {
		if cs.OrganizationID == arg.OrganizationID {
			out = append(out, cs)
		}
	}
	return out, nil
}

func (q *fakeChangesetQueries) SaveChangesetLandingPlan(ctx context.Context, arg db.SaveChangesetLandingPlanParams) (db.Changeset, error) {
	cs := q.changesets[arg.ID]
	cs.State = arg.State
	cs.LandingPlan = arg.LandingPlan
	cs.FailureReason = arg.FailureReason
	q.changesets[arg.ID] = cs
	var plan changesetLandingPlan
	if err := json.Unmarshal(arg.LandingPlan, &plan); err != nil {
		return db.Changeset{}, err
	}
	for _, member := range plan.Members {
		_ = q.RecordChangesetMemberPreviousCommit(ctx, db.RecordChangesetMemberPreviousCommitParams{ID: member.ID, PreviousCommitID: member.Previous})
	}
	return cs, nil
}

func (q *fakeChangesetQueries) MarkChangesetLanding(_ context.Context, id int64) (db.Changeset, error) {
	cs, ok := q.changesets[id]
	if !ok || (cs.State != changesetStatePending && cs.State != changesetStateFailed) {
		return db.Changeset{}, pgx.ErrNoRows
	}
	cs.State = changesetStateLanding
	cs.FailureReason = ""
	q.changesets[id] = cs
	return cs, nil
}

func (q *fakeChangesetQueries) MarkChangesetLanded(_ context.Context, arg db.MarkChangesetLandedParams) (db.Changeset, error) {
	cs := q.changesets[arg.ID]
	cs.State = changesetStateLanded
	cs.LandedCommitID = arg.LandedCommitID
	cs.LandedAt = pgtype.Timestamptz{Valid: true}
	q.changesets[arg.ID] = cs
	return cs, nil
}

func (q *fakeChangesetQueries) MarkChangesetFailed(_ context.Context, arg db.MarkChangesetFailedParams) (db.Changeset, error) {
	cs := q.changesets[arg.ID]
	cs.State = changesetStateFailed
	cs.FailureReason = arg.FailureReason
	q.changesets[arg.ID] = cs
	return cs, nil
}

func (q *fakeChangesetQueries) RecordChangesetMemberPreviousCommit(_ context.Context, arg db.RecordChangesetMemberPreviousCommitParams) error {
	q.updateMember(arg.ID, func(m *db.ChangesetMember) { m.PreviousCommitID = arg.PreviousCommitID })
	return nil
}

func (q *fakeChangesetQueries) RecordChangesetMemberLanded(_ context.Context, arg db.RecordChangesetMemberLandedParams) error {
	q.updateMember(arg.ID, func(m *db.ChangesetMember) { m.LandedCommitID = arg.LandedCommitID })
	return nil
}

func (q *fakeChangesetQueries) ClearChangesetMemberLanded(_ context.Context, changesetID int64) error {
	for i := range q.csMembers[changesetID] {
		q.csMembers[changesetID][i].LandedCommitID = ""
	}
	return nil
}

func (q *fakeChangesetQueries) updateMember(id int64, fn func(*db.ChangesetMember)) {
	for csID := range q.csMembers {
		for i := range q.csMembers[csID] {
			if q.csMembers[csID][i].ID == id {
				fn(&q.csMembers[csID][i])
			}
		}
	}
}

// fakeChangesetRepoHost simulates repo-host bookmarks and landings per repo.
type fakeChangesetRepoHost struct {
	changes     map[string]repohost.Change   // key owner/repo/changeID
	bookmarks   map[string]repohost.Bookmark // key owner/repo/name
	landFail    map[string]error             // key owner/repo -> error to return from LandChanges
	composed    []repohost.ComposeSuperprojectRequest
	landCalls   []string
	bookmarkOps []string
	receipts    map[string]repohost.LandResult
	composeSeq  int
}

func newFakeChangesetRepoHost() *fakeChangesetRepoHost {
	return &fakeChangesetRepoHost{
		changes:   map[string]repohost.Change{},
		bookmarks: map[string]repohost.Bookmark{},
		landFail:  map[string]error{},
	}
}

func (f *fakeChangesetRepoHost) key(parts ...string) string { return strings.Join(parts, "/") }

func (f *fakeChangesetRepoHost) GetChange(_ context.Context, owner, repo, changeID string) (repohost.Change, error) {
	c, ok := f.changes[f.key(owner, repo, changeID)]
	if !ok {
		for key, change := range f.changes {
			if strings.HasPrefix(key, f.key(owner, repo)+"/") && change.CommitID == changeID {
				return change, nil
			}
		}
		return repohost.Change{}, &repohost.StatusError{StatusCode: 404, Message: "change not found"}
	}
	return c, nil
}

func (f *fakeChangesetRepoHost) ListBookmarks(_ context.Context, owner, repo string, _ string, _ int) ([]repohost.Bookmark, string, error) {
	var out []repohost.Bookmark
	prefix := f.key(owner, repo) + "/"
	for k, b := range f.bookmarks {
		if strings.HasPrefix(k, prefix) {
			out = append(out, b)
		}
	}
	return out, "", nil
}

func (f *fakeChangesetRepoHost) LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
	if req.OperationKey != "" {
		if receipt, ok := f.receipts[req.OperationKey]; ok {
			return receipt, nil
		}
	}
	if req.LookupOnly {
		return repohost.LandResult{}, &repohost.StatusError{StatusCode: 404, Message: "receipt not found"}
	}
	change, err := f.GetChange(ctx, owner, repo, req.ChangeIDs[0])
	if err != nil {
		return repohost.LandResult{}, err
	}
	f.landCalls = append(f.landCalls, f.key(owner, repo, change.ChangeID, req.TargetBookmark))
	if err := f.landFail[f.key(owner, repo)]; err != nil {
		return repohost.LandResult{}, err
	}
	if req.ExpectedCommitID != nil && f.bookmarks[f.key(owner, repo, req.TargetBookmark)].TargetCommitID != *req.ExpectedCommitID {
		return repohost.LandResult{}, &repohost.StatusError{StatusCode: 409, Message: "bookmark changed"}
	}
	f.bookmarks[f.key(owner, repo, req.TargetBookmark)] = repohost.Bookmark{Name: req.TargetBookmark, TargetChangeID: change.ChangeID, TargetCommitID: change.CommitID}
	result := repohost.LandResult{LandedCount: 1, TargetBookmark: req.TargetBookmark, TargetCommitID: change.CommitID}
	if f.receipts == nil {
		f.receipts = map[string]repohost.LandResult{}
	}
	f.receipts[req.OperationKey] = result
	return result, nil
}

func (f *fakeChangesetRepoHost) CreateBookmark(ctx context.Context, owner, repo string, req repohost.CreateBookmarkRequest) (repohost.Bookmark, error) {
	if req.ExpectedCommitID != nil && f.bookmarks[f.key(owner, repo, req.Name)].TargetCommitID != *req.ExpectedCommitID {
		return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 409, Message: "bookmark changed"}
	}
	if req.Delete {
		err := f.DeleteBookmark(ctx, owner, repo, req.Name)
		return repohost.Bookmark{}, err
	}
	f.bookmarkOps = append(f.bookmarkOps, "create "+f.key(owner, repo, req.Name, req.TargetChangeID))
	change, err := f.GetChange(ctx, owner, repo, req.TargetChangeID)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	b := repohost.Bookmark{Name: req.Name, TargetChangeID: change.ChangeID, TargetCommitID: change.CommitID}
	f.bookmarks[f.key(owner, repo, req.Name)] = b
	return b, nil
}

func (f *fakeChangesetRepoHost) DeleteBookmark(_ context.Context, owner, repo, name string) error {
	f.bookmarkOps = append(f.bookmarkOps, "delete "+f.key(owner, repo, name))
	delete(f.bookmarks, f.key(owner, repo, name))
	return nil
}

func (f *fakeChangesetRepoHost) ComposeSuperproject(_ context.Context, owner, repo string, req repohost.ComposeSuperprojectRequest) (repohost.SuperprojectCommit, error) {
	f.composed = append(f.composed, req)
	f.composeSeq++
	changeID := fmt.Sprintf("spchange%024d", f.composeSeq)
	commitID := fmt.Sprintf("%040d", f.composeSeq)
	f.changes[f.key(owner, repo, changeID)] = repohost.Change{ChangeID: changeID, CommitID: commitID}
	return repohost.SuperprojectCommit{ChangeID: changeID, CommitID: commitID, Description: req.Description, Members: req.Members}, nil
}

// BackoutChange records a reverting change parented on the target's head.
func (f *fakeChangesetRepoHost) BackoutChange(_ context.Context, owner, repo, changeID string, req repohost.BackoutChangeRequest) (repohost.Change, error) {
	f.composeSeq++
	change := repohost.Change{ChangeID: fmt.Sprintf("backout%025d", f.composeSeq), CommitID: fmt.Sprintf("f%039d", f.composeSeq), ParentCommitID: f.bookmarks[f.key(owner, repo, req.TargetBookmark)].TargetCommitID}
	f.changes[f.key(owner, repo, change.ChangeID)] = change
	f.bookmarkOps = append(f.bookmarkOps, "backout "+f.key(owner, repo, changeID, req.Revision))
	return change, nil
}

func (f *fakeChangesetRepoHost) GetSuperproject(_ context.Context, owner, repo, revision string) (repohost.SuperprojectCommit, error) {
	c, ok := f.changes[f.key(owner, repo, revision)]
	if !ok {
		return repohost.SuperprojectCommit{}, &repohost.StatusError{StatusCode: 404, Message: "not found"}
	}
	return repohost.SuperprojectCommit{ChangeID: c.ChangeID, CommitID: c.CommitID}, nil
}

func seedChangesetFixture(t *testing.T) (*fakeChangesetQueries, *fakeChangesetRepoHost, *ChangesetService) {
	t.Helper()
	q := newFakeChangesetQueries()
	rh := newSeededChangesetRepoHost()
	svc := NewChangesetService(q, rh, nil, nil)
	return q, rh, svc
}

// newSeededChangesetRepoHost serves two repositories with one feature change each.
func newSeededChangesetRepoHost() *fakeChangesetRepoHost {
	rh := newFakeChangesetRepoHost()
	// api: main at base-a, feature change a1; web: main at base-b, feature change b1.
	rh.changes["acme/api/aaaa"] = repohost.Change{ChangeID: "aaaa", CommitID: strings.Repeat("a", 40)}
	rh.changes["acme/api/abase"] = repohost.Change{ChangeID: "abase", CommitID: strings.Repeat("1", 40)}
	rh.bookmarks["acme/api/main"] = repohost.Bookmark{Name: "main", TargetChangeID: "abase", TargetCommitID: strings.Repeat("1", 40)}
	rh.changes["acme/web/bbbb"] = repohost.Change{ChangeID: "bbbb", CommitID: strings.Repeat("b", 40)}
	rh.changes["acme/web/bbase"] = repohost.Change{ChangeID: "bbase", CommitID: strings.Repeat("2", 40)}
	rh.bookmarks["acme/web/main"] = repohost.Bookmark{Name: "main", TargetChangeID: "bbase", TargetCommitID: strings.Repeat("2", 40)}
	return rh
}

func TestChangesetService_CreateAndLand(t *testing.T) {
	t.Parallel()
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1, Username: "alice"}

	created, err := svc.CreateChangeset(context.Background(), actor, "acme", CreateChangesetInput{
		Description: "ship api+web",
		Members: []ChangesetMemberInput{
			{Repo: "web", ChangeID: "bbbb"},
			{Repo: "acme/api", ChangeID: "aaaa"},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, "pending", created.State)
	assert.Equal(t, "acme/superproject", created.Superproject)
	require.Len(t, created.Members, 2)
	assert.Equal(t, "api", created.Members[0].Path, "members are sorted by repository")
	assert.Equal(t, strings.Repeat("a", 40), created.Members[0].CommitID)
	assert.Equal(t, "web", created.Members[1].Path)
	require.Len(t, rh.composed, 1)
	assert.Equal(t, "main", rh.composed[0].Bookmark)
	assert.Equal(t, []repohost.SuperprojectMember{{Path: "api", CommitID: strings.Repeat("a", 40)}, {Path: "web", CommitID: strings.Repeat("b", 40)}}, rh.composed[0].Members)

	landed, err := svc.LandChangeset(context.Background(), actor, "acme", created.ID)
	require.NoError(t, err)
	assert.Equal(t, "landed", landed.State)
	assert.Equal(t, created.CommitID, landed.LandedCommitID, "fast-forward landing keeps the proposal commit as the org timeline head")
	assert.Equal(t, strings.Repeat("a", 40), landed.Members[0].LandedCommitID)
	assert.Equal(t, strings.Repeat("1", 40), landed.Members[0].PreviousCommitID)
	assert.Equal(t, strings.Repeat("b", 40), landed.Members[1].LandedCommitID)
	// Both member bookmarks and the superproject bookmark advanced.
	assert.Equal(t, strings.Repeat("a", 40), rh.bookmarks["acme/api/main"].TargetCommitID)
	assert.Equal(t, strings.Repeat("b", 40), rh.bookmarks["acme/web/main"].TargetCommitID)
	assert.Equal(t, created.CommitID, rh.bookmarks["acme/superproject/main"].TargetCommitID)
	assert.Equal(t, []string{"acme/api/aaaa/main", "acme/web/bbbb/main", "acme/superproject/" + created.ChangeID + "/main"}, rh.landCalls)
	assert.Equal(t, "landed", q.changesets[created.ID].State)

	// Landing again is refused.
	_, err = svc.LandChangeset(context.Background(), actor, "acme", created.ID)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, 409, apiErr.Status)
}

func TestChangesetService_LandRollsBackWhenSecondMemberFails(t *testing.T) {
	t.Parallel()
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1, Username: "alice"}
	created, err := svc.CreateChangeset(context.Background(), actor, "acme", CreateChangesetInput{
		Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}, {Repo: "web", ChangeID: "bbbb"}},
	})
	require.NoError(t, err)

	rh.landFail["acme/web"] = &repohost.StatusError{StatusCode: 409, Message: "landing produced merge conflicts"}

	_, err = svc.LandChangeset(context.Background(), actor, "acme", created.ID)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, 409, apiErr.Status)

	// api landed first, then web failed: api's main moved forward to a revert
	// of the member, and the superproject bookmark never moved.
	revert := rh.bookmarks["acme/api/main"]
	assert.True(t, strings.HasPrefix(revert.TargetChangeID, "backout"), "api main was rewound instead of reverted: %+v", revert)
	assert.Equal(t, strings.Repeat("2", 40), rh.bookmarks["acme/web/main"].TargetCommitID)
	_, superLanded := rh.bookmarks["acme/superproject/main"]
	assert.False(t, superLanded)
	assert.Equal(t, []string{"backout acme/api/aaaa/" + strings.Repeat("a", 40)}, rh.bookmarkOps)
	assert.Equal(t, []string{"acme/api/aaaa/main", "acme/web/bbbb/main", "acme/api/" + revert.TargetChangeID + "/main"}, rh.landCalls)

	cs := q.changesets[created.ID]
	assert.Equal(t, "failed", cs.State)
	assert.Contains(t, cs.FailureReason, "landing produced merge conflicts")
	assert.Contains(t, cs.FailureReason, "status 409")
	for _, m := range q.csMembers[created.ID] {
		assert.Empty(t, m.LandedCommitID, "rollback clears landed markers")
	}

	// A retry reapplies api by backing out the revert, then lands it.
	delete(rh.landFail, "acme/web")
	landed, err := svc.LandChangeset(context.Background(), actor, "acme", created.ID)
	require.NoError(t, err)
	assert.Equal(t, "landed", landed.State)
	assert.Equal(t, "backout acme/api/"+revert.TargetChangeID+"/"+revert.TargetCommitID, rh.bookmarkOps[1])
	assert.Equal(t, rh.bookmarks["acme/api/main"].TargetCommitID, landed.Members[0].LandedCommitID)
	assert.NotEqual(t, revert.TargetCommitID, landed.Members[0].LandedCommitID)
}

func TestChangesetService_PreflightRefusesConflictedMemberWithoutMovingAnything(t *testing.T) {
	t.Parallel()
	q, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1, Username: "alice"}
	created, err := svc.CreateChangeset(context.Background(), actor, "acme", CreateChangesetInput{
		Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}, {Repo: "web", ChangeID: "bbbb"}},
	})
	require.NoError(t, err)

	// web's change becomes conflicted after the changeset was created.
	web := rh.changes["acme/web/bbbb"]
	web.HasConflict = true
	rh.changes["acme/web/bbbb"] = web

	_, err = svc.LandChangeset(context.Background(), actor, "acme", created.ID)
	require.Error(t, err)
	assert.Empty(t, rh.landCalls, "no member lands when preflight fails")
	assert.Equal(t, strings.Repeat("1", 40), rh.bookmarks["acme/api/main"].TargetCommitID)
	assert.Equal(t, "failed", q.changesets[created.ID].State)
	assert.Contains(t, q.changesets[created.ID].FailureReason, "unresolved conflicts")
}

func TestChangesetService_CreateValidation(t *testing.T) {
	t.Parallel()
	_, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	stranger := &db.User{ID: 2}

	cases := []struct {
		name   string
		actor  *db.User
		input  CreateChangesetInput
		status int
	}{
		{"non-member", stranger, CreateChangesetInput{Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}}}, 403},
		{"no members", actor, CreateChangesetInput{}, 400},
		{"unknown repo", actor, CreateChangesetInput{Members: []ChangesetMemberInput{{Repo: "nope", ChangeID: "aaaa"}}}, 404},
		{"unknown change", actor, CreateChangesetInput{Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "zzzz"}}}, 404},
		{"duplicate member", actor, CreateChangesetInput{Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}, {Repo: "API", ChangeID: "aaaa"}}}, 400},
		{"superproject as member", actor, CreateChangesetInput{Members: []ChangesetMemberInput{{Repo: "superproject", ChangeID: "aaaa"}}}, 400},
		{"foreign org prefix", actor, CreateChangesetInput{Members: []ChangesetMemberInput{{Repo: "other/api", ChangeID: "aaaa"}}}, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.CreateChangeset(context.Background(), tc.actor, "acme", tc.input)
			var apiErr *pkgerrors.APIError
			require.True(t, errors.As(err, &apiErr), "expected API error, got %v", err)
			assert.Equal(t, tc.status, apiErr.Status)
		})
	}
	assert.Empty(t, rh.composed, "nothing is composed when validation fails")

	// A conflicted member is refused at creation time too.
	api := rh.changes["acme/api/aaaa"]
	api.HasConflict = true
	rh.changes["acme/api/aaaa"] = api
	_, err := svc.CreateChangeset(context.Background(), actor, "acme", CreateChangesetInput{Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}}})
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, 409, apiErr.Status)
}

func TestChangesetService_MaterializeChangeset(t *testing.T) {
	t.Parallel()
	_, _, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	created, err := svc.CreateChangeset(context.Background(), actor, "acme", CreateChangesetInput{
		Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}, {Repo: "web", ChangeID: "bbbb"}},
	})
	require.NoError(t, err)

	members, err := svc.MaterializeChangeset(context.Background(), 1, created.ID)
	require.NoError(t, err)
	assert.Equal(t, []ChangesetMaterializedMember{
		{Owner: "acme", Repo: "api", CommitID: strings.Repeat("a", 40)},
		{Owner: "acme", Repo: "web", CommitID: strings.Repeat("b", 40)},
	}, members)

	_, err = svc.MaterializeChangeset(context.Background(), 2, created.ID)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, 403, apiErr.Status)

	_, err = svc.MaterializeChangeset(context.Background(), 1, 9999)
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, 404, apiErr.Status)
}

func TestChangesetService_ResponseParentsAndStacking(t *testing.T) {
	t.Parallel()
	_, rh, svc := seedChangesetFixture(t)
	actor := &db.User{ID: 1}
	first, err := svc.CreateChangeset(context.Background(), actor, "acme", CreateChangesetInput{
		Members: []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}},
	})
	require.NoError(t, err)
	second, err := svc.CreateChangeset(context.Background(), actor, "acme", CreateChangesetInput{
		ParentChangeID: first.ChangeID,
		Members:        []ChangesetMemberInput{{Repo: "web", ChangeID: "bbbb"}},
	})
	require.NoError(t, err)
	assert.Equal(t, []string{first.ChangeID}, second.ParentChangeIDs)
	require.Len(t, rh.composed, 2)
	assert.Equal(t, first.ChangeID, rh.composed[1].ParentChangeID)

	var raw []string
	require.NoError(t, json.Unmarshal([]byte(`["`+first.ChangeID+`"]`), &raw))
	got, err := svc.GetChangeset(context.Background(), actor, "acme", second.ID)
	require.NoError(t, err)
	assert.Equal(t, raw, got.ParentChangeIDs)
}
