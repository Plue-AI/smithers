package services

import (
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The fixed UUID was computed independently using RFC 4122 UUIDv5. A completed
// importer row models process loss after publication but before setup checkpoint.
func TestInstallSourceImportAdmissionRecoveryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "recovery", LowerUsername: "recovery"})
	require.NoError(t, err)
	const operation = "4c3b8e49-ea07-4bf5-84e1-7c89d337fe24"
	const importID = "f97d73e6-9d2d-5639-bba3-bc2e72e3f0a8"
	_, err = pool.Exec(ctx, `INSERT INTO import_jobs(id,user_id,github_owner,github_repo,repo_owner,repo_name,branch,target_bookmark,status) VALUES($1,$2,'recovery','app','recovery','app','main','main','ready')`, importID, owner.ID)
	require.NoError(t, err)
	service := NewGitHubImportService(pool, q, q, &testGitHubImportRepoHost{}, testGitHubImportDecrypter{}, "http://unused.invalid")
	// This fixture only reconciles admission; no repository transport is invoked.
	service.pool = pool
	input := ImportGitHubRepoInput{UserID: owner.ID, Owner: "recovery", Repo: "app", Branch: "main", setupOperationID: operation}
	var wg sync.WaitGroup
	results := make(chan ImportJob, 8)
	failures := make(chan error, 8)
	for range 8 {
		wg.Go(func() { job, err := service.StartImport(ctx, input); results <- job; failures <- err })
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		require.NoError(t, err)
	}
	for job := range results {
		require.Equal(t, importID, job.ImportJobID)
		require.Equal(t, "ready", job.Status)
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM import_jobs`).Scan(&count))
	require.Equal(t, 1, count)
	input.Repo = "other"
	_, err = service.StartImport(ctx, input)
	require.ErrorContains(t, err, "setup import inputs changed")
	_, err = pool.Exec(ctx, `UPDATE import_jobs SET status='failed', error='interrupted' WHERE id=$1`, importID)
	require.NoError(t, err)
	input.Repo = "app"
	job, err := service.StartImport(ctx, input)
	require.NoError(t, err)
	require.Equal(t, importID, job.ImportJobID)
	require.Equal(t, "cloning", job.Status)
	job, err = service.StartImport(ctx, input)
	require.NoError(t, err)
	require.Equal(t, importID, job.ImportJobID)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM import_jobs`).Scan(&count))
	require.Equal(t, 1, count)
}
