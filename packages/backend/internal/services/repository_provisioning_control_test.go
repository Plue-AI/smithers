package services

import (
	"context"
	stdErrors "errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

var errRolloutPrepareReached = stdErrors.New("rollout test reached durable storage preparation")

type rolloutProvisioningHost struct {
	*mockRepoHostClient
	prepareInitCalls int
	prepareForkCalls int
}

func (h *rolloutProvisioningHost) PrepareStagedInit(
	context.Context, string, string, string, string, bool,
) (repohost.StagedProvision, error) {
	h.prepareInitCalls++
	return repohost.StagedProvision{}, errRolloutPrepareReached
}

func (h *rolloutProvisioningHost) PrepareStagedFork(
	context.Context, string, string, string, string, string,
) (repohost.StagedProvision, error) {
	h.prepareForkCalls++
	return repohost.StagedProvision{}, errRolloutPrepareReached
}

func (*rolloutProvisioningHost) ExecuteStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

func (*rolloutProvisioningHost) PublishStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

func (*rolloutProvisioningHost) FinalizeStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

func (*rolloutProvisioningHost) AbortStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

type rolloutRepoQuerier struct {
	*mockRepoQuerier
	canonicalUser db.User
	canonicalOrg  db.Organization
}

func (q *rolloutRepoQuerier) GetUserByID(context.Context, int64) (db.User, error) {
	return q.canonicalUser, nil
}

func (q *rolloutRepoQuerier) GetOrgByID(context.Context, int64) (db.Organization, error) {
	return q.canonicalOrg, nil
}

func requireRepositoryRolloutUnavailable(t *testing.T, err error) {
	t.Helper()
	apiErr := apiError(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeRepositoryProvisioningRollout, apiErr.Code)
}

func TestRepoServiceDurableCreatesStayGatedUntilEnabled(t *testing.T) {
	pool := getAgentTestPool(t)
	actor := &db.User{ID: 7, Username: "bob", LowerUsername: "bob"}

	t.Run("missing injected journal stays unavailable after enable", func(t *testing.T) {
		q := &rolloutRepoQuerier{mockRepoQuerier: &mockRepoQuerier{}}
		host := &rolloutProvisioningHost{mockRepoHostClient: &mockRepoHostClient{}}
		svc := NewRepoServiceWithPool(q, host, "s1", pool)
		svc.EnableDurableProvisioning()
		_, err := svc.CreateRepo(context.Background(), actor, "missing-store", "", true, "main", false)
		requireRepositoryRolloutUnavailable(t, err)
		assert.Zero(t, host.prepareInitCalls)
	})

	t.Run("user repository", func(t *testing.T) {
		createCalls := 0
		q := &rolloutRepoQuerier{mockRepoQuerier: &mockRepoQuerier{
			createRepoFn: func(context.Context, db.CreateRepoParams) (db.Repository, error) {
				createCalls++
				return db.Repository{}, nil
			},
		}}
		host := &rolloutProvisioningHost{mockRepoHostClient: &mockRepoHostClient{}}
		svc := NewRepoServiceWithPool(q, host, "s1", pool, WithRepoProvisioningStore(struct{ RepositoryProvisioningStore }{}))

		_, err := svc.CreateRepo(context.Background(), actor, "demo", "", true, "main", false)
		requireRepositoryRolloutUnavailable(t, err)
		assert.Zero(t, host.prepareInitCalls)
		assert.Zero(t, createCalls)

		svc.EnableDurableProvisioning()
		_, err = svc.CreateRepo(context.Background(), actor, "demo", "", true, "main", false)
		assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
		assert.Equal(t, 1, host.prepareInitCalls, "enabled service must proceed into durable preparation")
		assert.Zero(t, createCalls)
	})

	t.Run("organization repository", func(t *testing.T) {
		createCalls := 0
		q := &rolloutRepoQuerier{mockRepoQuerier: &mockRepoQuerier{
			getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
				return db.Organization{ID: 9, Name: "acme", LowerName: "acme"}, nil
			},
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: 9, UserID: actor.ID, Role: "owner"}, nil
			},
			createOrgRepoFn: func(context.Context, db.CreateOrgRepoParams) (db.Repository, error) {
				createCalls++
				return db.Repository{}, nil
			},
		}}
		host := &rolloutProvisioningHost{mockRepoHostClient: &mockRepoHostClient{}}
		svc := NewRepoServiceWithPool(q, host, "s1", pool, WithRepoProvisioningStore(struct{ RepositoryProvisioningStore }{}))

		_, err := svc.CreateOrgRepo(context.Background(), actor, "acme", "demo", "", true, "main", false)
		requireRepositoryRolloutUnavailable(t, err)
		assert.Zero(t, host.prepareInitCalls)
		assert.Zero(t, createCalls)

		svc.EnableDurableProvisioning()
		_, err = svc.CreateOrgRepo(context.Background(), actor, "acme", "demo", "", true, "main", false)
		assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
		assert.Equal(t, 1, host.prepareInitCalls)
		assert.Zero(t, createCalls)
	})

}

func TestGitHubImportStartStaysGatedUntilDurableWorkerEnabled(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, owner := createProvisioningTestUser(t)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM import_jobs WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	host := &candidateFallbackStagedHost{testGitHubImportRepoHost: &testGitHubImportRepoHost{}}
	svc := NewGitHubImportService(
		pool, &testGitHubImportRepoDB{}, testGitHubImportTokenDB{}, host,
		testGitHubImportDecrypter{}, "https://smithers.test", WithGitHubImportProductProvisioning(pool),
	)
	input := ImportGitHubRepoInput{UserID: userID, Owner: "octo", Repo: "demo", Branch: "main"}

	_, err := svc.StartImport(ctx, input)
	requireRepositoryRolloutUnavailable(t, err)
	var jobCount int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM import_jobs WHERE user_id = $1`, userID).Scan(&jobCount))
	assert.Zero(t, jobCount, "compatibility gate must reject before persisting a job")

	svc.EnableDurableWorker()
	job, err := svc.StartImport(ctx, input)
	require.NoError(t, err)
	assert.Equal(t, "cloning", job.Status)
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM import_jobs WHERE user_id = $1`, userID).Scan(&jobCount))
	assert.Equal(t, int64(1), jobCount)
	assert.Equal(t, owner, job.RepoOwner)
}
