package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

func TestBillingWebhookUsesItemPeriodsAndStripeMinorUnits(t *testing.T) {
	t.Parallel()

	var payload stripeSubscriptionPayload
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"sub_basil",
		"current_period_start":10,
		"current_period_end":20,
		"items":{"data":[{
			"quantity":2,
			"current_period_start":30,
			"current_period_end":40,
			"price":{"id":"price_1","recurring":{"interval":"month"}}
		}]}
	}`), &payload))

	snapshot := snapshotFromWebhookSubscription(payload, nil)
	assert.Equal(t, time.Unix(30, 0).UTC(), snapshot.CurrentPeriodStart)
	assert.Equal(t, time.Unix(40, 0).UTC(), snapshot.CurrentPeriodEnd)
	assert.Equal(t, int64(2), snapshot.Quantity)

	assert.Equal(t, "5.00 USD", formatMoneyCents(500, "usd"))
	assert.Equal(t, "500 JPY", formatMoneyCents(500, "jpy"))
	assert.Equal(t, "5.00 UGX", formatMoneyCents(500, "ugx"),
		"Stripe keeps charge amounts for UGX in its backwards-compatible two-decimal representation")
	assert.Equal(t, "-92233720368547758.08 USD", formatMoneyCents(math.MinInt64, "usd"))
}

func TestGitHubSourceValidationAllowsLeadingDotRepository(t *testing.T) {
	t.Parallel()

	owner, repo, err := normalizeRepoRef(" Octo-Org ", " .GitHub ")
	require.NoError(t, err)
	assert.Equal(t, "octo-org", owner)
	assert.Equal(t, ".github", repo)

	_, _, err = normalizeRepoRef("octo", "bad/name")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	for _, traversalName := range []string{".", ".."} {
		_, _, err = normalizeRepoRef("octo", traversalName)
		assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	}
	_, _, err = normalizeRepoRef("octo", strings.Repeat("a", 101))
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
}

type atomicImportStartDB struct {
	jobID  string
	branch string
}

func (d *atomicImportStartDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	switch sql {
	case `SELECT username FROM users WHERE id = $1`:
		return githubImportHRow{username: "alice"}
	case createImportJobSQL:
		row := githubImportHRow{jobID: d.jobID, created: false}
		if d.branch != "" && d.branch != "main" {
			return importJobBranchRow{githubImportHRow: row, branch: d.branch}
		}
		return row
	default:
		return githubImportHRow{err: fmt.Errorf("unexpected follow-up query after atomic import conflict")}
	}
}

type importJobBranchRow struct {
	githubImportHRow
	branch string
}

func (r importJobBranchRow) Scan(dest ...any) error {
	if err := r.githubImportHRow.Scan(dest...); err != nil {
		return err
	}
	*(dest[8].(*string)) = r.branch
	*(dest[9].(*string)) = r.branch
	return nil
}

func TestGitHubImportStartReturnsAtomicConflictWinner(t *testing.T) {
	t.Parallel()

	newService := func(database GitHubImportDB) *GitHubImportService {
		return NewGitHubImportService(
			database,
			githubImportHRepoDB{},
			githubImportHTokenDB{},
			&githubImportHRepoHost{},
			githubImportHDecrypter{},
			"https://smithers.test",
		)
	}

	winnerID := "11111111-1111-1111-1111-111111111111"
	job, err := newService(&atomicImportStartDB{jobID: winnerID}).StartImport(context.Background(), ImportGitHubRepoInput{
		UserID: 7, Owner: "octo", Repo: "demo", Branch: "main",
	})
	require.NoError(t, err)
	assert.Equal(t, winnerID, job.ImportJobID)

	_, err = newService(&atomicImportStartDB{jobID: winnerID, branch: "main"}).StartImport(context.Background(), ImportGitHubRepoInput{
		UserID: 7, Owner: "octo", Repo: "demo", Branch: "other",
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeGitHubImportAlreadyActive, apiErr.Code)
}

func TestGitHubAuthenticatedNotFoundIsTerminal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	svc := NewGitHubImportService(
		nil,
		nil,
		testGitHubImportTokenDB{accounts: []db.OauthAccount{{Provider: "github", AccessTokenEncrypted: []byte("encrypted")}}},
		&testGitHubImportRepoHost{},
		testGitHubImportDecrypter{token: "gho_token"},
		"https://smithers.test",
		WithGitHubImportHTTPClient(server.Client()),
	)
	_, _, _, err := svc.githubCloneInfoForRepo(context.Background(), 7, "octo", "missing")
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))
	assert.True(t, isTerminalGitHubImportFailure(err))
}

func TestDefaultBookmarkEnforcesDatabaseCharacterLimit(t *testing.T) {
	t.Parallel()

	require.NoError(t, validateDefaultBookmark(strings.Repeat("é", 255)))
	assert.Error(t, validateDefaultBookmark(strings.Repeat("é", 256)))
	assert.Error(t, validateDefaultBookmark(strings.Repeat("a", 256)))
}

func TestRepositoryProvisionIdentityClassificationPreservesDatabaseErrors(t *testing.T) {
	t.Parallel()

	databaseErr := stdErrors.New("database unavailable")
	assert.ErrorIs(t, classifyRepositoryProvisionIdentity(databaseErr, false), databaseErr)
	assert.ErrorIs(t, classifyRepositoryProvisionIdentity(pgx.ErrNoRows, false), errRepositoryProvisionMismatch)
	assert.ErrorIs(t, classifyRepositoryProvisionIdentity(nil, false), errRepositoryProvisionMismatch)
	assert.NoError(t, classifyRepositoryProvisionIdentity(nil, true))
}

func TestReservedSecretMarkerIsRejectedAcrossConfigurationBoundaries(t *testing.T) {
	t.Parallel()

	assert.False(t, IsInjectedSecretName(SecretEnvKeysRuntimeMarker))
	actor := &db.User{ID: 1}

	_, err := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).SetSecret(
		context.Background(), actor, "alice", "demo", SecretEnvKeysRuntimeMarker, "secret", nil, nil)
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
	_, err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).SetOrgSecret(
		context.Background(), actor, "acme", SecretEnvKeysRuntimeMarker, "secret", nil)
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
	_, err = NewVariableService(&mockVariableQuerier{}).SetVariable(
		context.Background(), actor, "alice", "demo", SecretEnvKeysRuntimeMarker, "value")
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
	_, err = NewVariableService(&mockVariableQuerier{}).SetOrgVariable(
		context.Background(), actor, "acme", SecretEnvKeysRuntimeMarker, "value")
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	secrets := []string{SecretEnvKeysRuntimeMarker}
	assert.Error(t, validateWorkflowJobSecrets(JobConfig{Name: "build", Secrets: &secrets}))

	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(context.Context, int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{{Name: SecretEnvKeysRuntimeMarker, Value: "user-value"}}, nil
		},
	}, webhook.NoopSecretCodec{})
	_, _, err = injector.RepositoryEnvironmentAndSecrets(context.Background(), 42, false)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not a valid environment variable name")
}

func TestRepositoryStorageOperationRetryYieldsToUntouchedWork(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	store := newPostgresRepositoryStorageOperationStore(pool)
	firstRepositoryID := -time.Now().UnixNano()
	secondRepositoryID := firstRepositoryID - 1
	firstToken := newRepositoryProvisionClaimToken()
	secondToken := newRepositoryProvisionClaimToken()

	_, err := pool.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_route_key,
			source_owner, source_repo, source_user_id, created_at, updated_at
		) VALUES
			($1, 'delete', $2, 's1', 'owner', 'first', 1, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'),
			($3, 'delete', $4, 's1', 'owner', 'second', 1, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')
	`, firstRepositoryID, firstToken, secondRepositoryID, secondToken)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM repository_storage_operations WHERE repository_id IN ($1, $2)`, firstRepositoryID, secondRepositoryID)
	})

	claimToken := newRepositoryProvisionClaimToken()
	claimed, err := store.Claim(ctx, claimToken, time.Second, time.Minute, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, firstRepositoryID, claimed[0].RepositoryID)

	retryErr := stdErrors.New("repo-host remains unavailable")
	processed, err := store.ProcessClaim(ctx, claimed[0], claimToken, func(context.Context, repositoryStorageOperation, *db.Repository) error {
		return retryErr
	})
	assert.False(t, processed)
	assert.ErrorIs(t, err, retryErr)

	claimed, err = store.Claim(ctx, newRepositoryProvisionClaimToken(), time.Second, time.Minute, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, secondRepositoryID, claimed[0].RepositoryID,
		"the released poison operation must move behind untouched journals")
}
