package services

import (
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// installationOf reads the App installation the install has recorded for
// owner/repo, or 0 when it has none.
func (f *setupFixture) installationOf(t *testing.T, owner, repo string) int64 {
	t.Helper()
	var installation int64
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT COALESCE(MAX(installation_id), 0) FROM github_app_installation_repositories
		WHERE owner_login_lower = $1 AND repo_name_lower = $2`, owner, repo).Scan(&installation))
	return installation
}

// publication is TODO publication as the install composes it
// (EnableTodoPublication) for the fixture's repository, whose stack the
// source step asks for and whose GitHub destination is the chosen slug.
func (f *setupFixture) publication(t *testing.T) *MythicalService {
	t.Helper()
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `UPDATE repositories SET mirror_destination = $2 WHERE id = $1`, f.repo, setupGitHubSlug)
	require.NoError(t, err)
	_, err = db.New(f.pool).RequestMythicalBootstrap(ctx, f.repo, f.owner.ID, 100, false)
	require.NoError(t, err)
	mythical := NewMythicalService(f.pool, nil)
	mythical.EnableTodoPublication(f.app, f.connections, NewBudgetTracker())
	return mythical
}

// An install whose address is not public https gets no installation webhook
// (its App has no hook), and the hourly sweep may be an hour away. The
// repository step itself records the App's installation on the chosen
// repository, so once the step is done publication's check passes with no
// webhook delivered and no sweep run.
func TestInstallRepositoryStepRecordsTheAppInstallationPostgres(t *testing.T) {
	f, fake := newProviderFixture(t, "repository", &sourceImports{}, installedApp)
	f.signInOwner(t, fake)
	ctx := t.Context()
	mythical := f.publication(t)
	item := db.MythicalItem{RepositoryID: f.repo}
	require.EqualError(t, mythical.canonicalApp(ctx, item, ""), "the install's GitHub App is not installed on acme/app",
		"before the step publication refuses, as a localhost install did until the hourly sweep")

	_, err := f.svc.Admit(ctx, "repository", "repository-1", json.RawMessage(`{"repository":"`+setupGitHubSlug+`"}`))
	require.NoError(t, err)
	f.run(t, "repository")
	step := f.awaitStep(t, "repository", InstallReady)
	require.Nil(t, step.Error)

	require.EqualValues(t, 91, f.installationOf(t, "acme", "app"))
	require.NoError(t, mythical.canonicalApp(ctx, item, ""))
	target, err := mythical.publicationTarget(ctx, f.repo)
	require.NoError(t, err)
	require.EqualValues(t, 91, target.installation)
	require.Equal(t, "acme", target.githubOwner)
	require.Equal(t, "app", target.githubRepo)
}

// A GitHub answer that leaves the chosen repository unlisted fails the step
// with a reason Retry clears; the repository is not recorded until a retry
// lists it.
func TestInstallRepositoryStepFailsRetryablyUntilGitHubListsTheRepositoryPostgres(t *testing.T) {
	f, fake := newProviderFixture(t, "repository", &sourceImports{}, installedApp)
	f.signInOwner(t, fake)
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `DELETE FROM install_settings WHERE key='repository'`)
	require.NoError(t, err)
	fake.FailNextReads("/installation/repositories", 1)

	first, err := f.svc.Admit(ctx, "repository", "repository-1", json.RawMessage(`{"repository":"`+setupGitHubSlug+`"}`))
	require.NoError(t, err)
	f.run(t, "repository")
	step := f.awaitStep(t, "repository", InstallFailed)
	require.Equal(t, &InstallReadinessError{Code: "github_app_repository_unlisted", Class: "github", Message: "GitHub did not list the repository for the App"}, step.Error)
	require.Nil(t, step.Blocked)
	require.Nil(t, f.setting(t, "repository"), "an unlisted repository was recorded as the install's repository")
	require.Zero(t, f.installationOf(t, "acme", "app"))

	retry, err := f.svc.Admit(ctx, "repository", "repository-retry", json.RawMessage(`{"repository":"`+setupGitHubSlug+`"}`))
	require.NoError(t, err)
	require.NotEqual(t, first.OperationID, retry.OperationID)
	step = f.awaitStep(t, "repository", InstallReady)
	require.Equal(t, retry.OperationID, step.OperationID)
	require.Equal(t, map[string]any{"value": `"` + setupGitHubSlug + `"`}, f.setting(t, "repository"))
	require.EqualValues(t, 91, f.installationOf(t, "acme", "app"))
}
