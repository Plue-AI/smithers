package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func productImportOrgFixture(t *testing.T, pool *pgxpool.Pool) (int64, int64) {
	t.Helper()
	ctx := context.Background()
	var userID, orgID int64
	if err := pool.QueryRow(ctx, `INSERT INTO users(username, lower_username)
		VALUES ('org-importer', 'org-importer') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO organizations(name, lower_name, description)
		VALUES ('review-org', 'review-org', '') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO org_members(organization_id, user_id, role)
		VALUES ($1, $2, 'owner')`, orgID, userID); err != nil {
		t.Fatal(err)
	}
	return userID, orgID
}

func TestProductImportReservesAndPublishesOrganizationMirror(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, orgID := productImportOrgFixture(t, pool)
	const claim = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const token = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	var jobID string
	if err := pool.QueryRow(ctx, `INSERT INTO import_jobs
		(user_id, github_owner, github_repo, repo_owner, repo_name, branch, claim_token, claimed_at)
		VALUES ($1, 'review-org', 'project', 'review-org', 'project', 'main', $2, NOW()) RETURNING id`,
		userID, claim).Scan(&jobID); err != nil {
		t.Fatal(err)
	}
	store := &productImportProvisioningStore{pool: pool}
	wanted := repositoryProvisioningOperation{
		OperationType: repositoryProvisionImport, Token: token, ActorID: userID,
		StorageSetID: DefaultStorageSetID, OwnerName: "review-org",
		OrgID: pgtype.Int8{Int64: orgID, Valid: true}, Name: "project", LowerName: "project",
		Description:     "Imported from github.com/review-org/project",
		DefaultBookmark: "main", ImportJobID: jobID, ImportJobClaimToken: claim,
	}
	reserved, err := store.Reserve(ctx, wanted)
	if err != nil || reserved.RepositoryID == 0 {
		t.Fatalf("reserve organization import: %+v %v", reserved, err)
	}
	recovered, err := store.GetByToken(ctx, token)
	if err != nil || recovered.OrgID != wanted.OrgID || recovered.UserID.Valid {
		t.Fatalf("recover organization owner: %+v %v", recovered, err)
	}
	if err := store.MarkPublishReady(ctx, reserved.RepositoryID, token, claim); err != nil {
		t.Fatal(err)
	}
	recovered, err = store.GetByToken(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Publish(ctx, recovered, claim)
	if err != nil || repo.OrgID != wanted.OrgID || repo.UserID.Valid {
		t.Fatalf("publish organization mirror: %+v %v", repo, err)
	}
	again, err := store.Publish(ctx, recovered, claim)
	if err != nil || again.ID != repo.ID {
		t.Fatalf("idempotent organization publication: %+v %v", again, err)
	}
}

func TestProductImportLoadsPublishedOrganizationMirrorForMember(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, orgID := productImportOrgFixture(t, pool)
	var repoID int64
	if err := pool.QueryRow(ctx, `INSERT INTO repositories
		(org_id, name, lower_name, description, is_public, default_bookmark)
		VALUES ($1, 'project', 'project', 'Imported from github.com/review-org/project', false, 'main')
		RETURNING id`, orgID).Scan(&repoID); err != nil {
		t.Fatal(err)
	}
	svc := &GitHubImportService{pool: pool, orgs: db.New(pool)}
	job := claimedGitHubImportJob{UserID: userID, RepoOwner: "review-org", RepoName: "project",
		RepositoryID: pgtype.Int8{Int64: repoID, Valid: true}}
	repo, found, err := svc.loadDurableImportRepository(ctx, job)
	if err != nil || !found || repo.ID != repoID {
		t.Fatalf("load published organization mirror: %+v %v %v", repo, found, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM org_members WHERE organization_id=$1 AND user_id=$2`, orgID, userID); err != nil {
		t.Fatal(err)
	}
	if _, found, err := svc.loadDurableImportRepository(ctx, job); err == nil || found {
		t.Fatalf("nonmember recognized published organization mirror: found=%v err=%v", found, err)
	}
}

func TestProductImportReservationSurvivesRestartAndPublishesOnce(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	var userID int64
	if err := pool.QueryRow(ctx, `INSERT INTO users(username, lower_username)
		VALUES ('alice', 'alice') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	const claimToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const provisionToken = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	var jobID string
	if err := pool.QueryRow(ctx, `INSERT INTO import_jobs
		(user_id, github_owner, github_repo, repo_owner, repo_name, branch, claim_token, claimed_at)
		VALUES ($1, 'upstream', 'project', 'alice', 'project', 'main', $2, NOW()) RETURNING id`,
		userID, claimToken).Scan(&jobID); err != nil {
		t.Fatal(err)
	}
	wanted := repositoryProvisioningOperation{
		OperationType: repositoryProvisionImport, Token: provisionToken,
		ActorID: userID, StorageSetID: DefaultStorageSetID,
		OwnerName: "alice", UserID: pgtype.Int8{Int64: userID, Valid: true},
		Name: "project", LowerName: "project", Description: "Imported from github.com/upstream/project",
		DefaultBookmark: "main", ImportJobID: jobID, ImportJobClaimToken: claimToken,
	}
	store := &productImportProvisioningStore{pool: pool}
	reserved, err := store.Reserve(ctx, wanted)
	if err != nil || reserved.RepositoryID == 0 {
		t.Fatalf("reserve product import: id=%d err=%v", reserved.RepositoryID, err)
	}
	// A new store instance simulates recovery after the process lost its reply.
	reopened := &productImportProvisioningStore{pool: pool}
	loaded, err := reopened.GetByToken(ctx, provisionToken)
	if err != nil || loaded.RepositoryID != reserved.RepositoryID || loaded.PublishReady {
		t.Fatalf("recover product import: %+v err=%v", loaded, err)
	}
	if err := reopened.AcquireProcessing(ctx, loaded.RepositoryID, provisionToken, claimToken); err != nil {
		t.Fatal(err)
	}
	if err := reopened.MarkPublishReady(ctx, loaded.RepositoryID, provisionToken, claimToken); err != nil {
		t.Fatal(err)
	}
	loaded, err = reopened.GetByToken(ctx, provisionToken)
	if err != nil || !loaded.PublishReady || loaded.DefaultBookmark != "main" {
		t.Fatalf("recover sealed mirror: %+v err=%v", loaded, err)
	}
	repository, err := reopened.Publish(ctx, loaded, claimToken)
	if err != nil {
		t.Fatal(err)
	}
	if repository.ID != reserved.RepositoryID || repository.Name != "project" || repository.IsPublic {
		t.Fatalf("published wrong repository: %+v", repository)
	}
	second, err := reopened.Publish(ctx, loaded, claimToken)
	if err != nil || second.ID != repository.ID {
		t.Fatalf("idempotent publication: %+v err=%v", second, err)
	}
	if err := reopened.Complete(ctx, repository.ID, provisionToken, claimToken); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE import_jobs SET status='ready' WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.GetByToken(ctx, provisionToken); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("completed import remains claimable: %v", err)
	}
	const abortClaim = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	const abortToken = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	var abortJobID string
	if err := pool.QueryRow(ctx, `INSERT INTO import_jobs
		(user_id, github_owner, github_repo, repo_owner, repo_name, branch, claim_token, claimed_at)
		VALUES ($1, 'upstream', 'aborted', 'alice', 'aborted', 'main', $2, NOW()) RETURNING id`,
		userID, abortClaim).Scan(&abortJobID); err != nil {
		t.Fatal(err)
	}
	abortWanted := wanted
	abortWanted.Token = abortToken
	abortWanted.Name = "aborted"
	abortWanted.LowerName = "aborted"
	abortWanted.Description = "Imported from github.com/upstream/aborted"
	abortWanted.ImportJobID = abortJobID
	abortWanted.ImportJobClaimToken = abortClaim
	abortReserved, err := reopened.Reserve(ctx, abortWanted)
	if err != nil {
		t.Fatal(err)
	}
	physicalAbortCalled := false
	if err := reopened.Abort(ctx, abortReserved, abortClaim, func(context.Context) error {
		physicalAbortCalled = true
		return nil
	}); err != nil || !physicalAbortCalled {
		t.Fatalf("compensate unpublished import: called=%v err=%v", physicalAbortCalled, err)
	}
	if _, err := reopened.GetByToken(ctx, abortToken); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("aborted reservation remains bound: %v", err)
	}
	// The same job can reserve fresh storage after compensation; a stale URL
	// or token from the aborted stage cannot publish that new reservation.
	abortWanted.Token = strings.Repeat("e", 64)
	if _, err := reopened.Reserve(ctx, abortWanted); err != nil {
		t.Fatalf("retry import after compensation: %v", err)
	}
}
