package admission_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/admission"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// raceAdmissions starts first, waits until its commit runs, starts second, and
// waits until PostgreSQL shows second blocked on the owner's advisory lock
// before letting first commit.
func raceAdmissions(t *testing.T, ctx context.Context, pool *pgxpool.Pool, first, second func(hold func(context.Context) error) error) (error, error) {
	t.Helper()
	entered, release := make(chan struct{}), make(chan struct{})
	firstErr := make(chan error, 1)
	go func() {
		firstErr <- first(func(ctx context.Context) error {
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	select {
	case <-entered:
	case err := <-firstErr:
		t.Fatalf("first admission failed before commit: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	secondErr := make(chan error, 1)
	go func() { secondErr <- second(func(context.Context) error { return nil }) }()
	for {
		var waiters int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname=current_database() AND wait_event='advisory'`).Scan(&waiters))
		if waiters == 1 {
			break
		}
		select {
		case err := <-secondErr:
			close(release)
			t.Fatalf("second admission bypassed owner lock: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	close(release)
	return <-firstErr, <-secondErr
}

func requirePlanLimit(t *testing.T, err error, kind string) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, pkgerrors.CodePlanLimitExceeded, apiErr.Code)
	require.Equal(t, kind, apiErr.LimitKind)
}

func TestMeteredConcurrentPublicCreatesEnforceRepositoryCap(t *testing.T) {
	pool := database(t)
	owner := user(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := pool.Exec(ctx, `INSERT INTO repositories (user_id, name, lower_name, is_public, default_bookmark)
		SELECT $1, 'repo-' || i, 'repo-' || i, true, 'main' FROM generate_series(1, 199) i`, owner)
	require.NoError(t, err)
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	create := func(name string) func(func(context.Context) error) error {
		return func(hold func(context.Context) error) error {
			return policy.AuthorizeRepoCreateCommitted(ctx, "user", owner, false, func(ctx context.Context) error {
				if err := hold(ctx); err != nil {
					return err
				}
				_, err := pool.Exec(ctx, `INSERT INTO repositories (user_id, name, lower_name, is_public, default_bookmark)
					VALUES ($1, $2, $2, true, 'main')`, owner, name)
				return err
			})
		}
	}
	firstErr, secondErr := raceAdmissions(t, ctx, pool, create("winner"), create("loser"))
	require.NoError(t, firstErr)
	requirePlanLimit(t, secondErr, "repositories")
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repositories WHERE user_id=$1`, owner).Scan(&count))
	require.Equal(t, 200, count)
}

func TestMeteredConcurrentOrgCreatesEnforceOwnedOrganizationCap(t *testing.T) {
	pool := database(t)
	owner := user(t, pool)
	other := user(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Two owned organizations and one membership that is not ownership.
	_, err := pool.Exec(ctx, `WITH orgs AS (
			INSERT INTO organizations (name, lower_name, description, visibility)
			SELECT 'org-' || $1::bigint || '-' || i, 'org-' || $1::bigint || '-' || i, '', 'private' FROM generate_series(1, 3) i
			RETURNING id, name)
		INSERT INTO org_members (organization_id, user_id, role)
		SELECT id, $1, CASE WHEN name LIKE '%-3' THEN 'member' ELSE 'owner' END FROM orgs`, owner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `WITH org AS (
			INSERT INTO organizations (name, lower_name, description, visibility)
			VALUES ('other-' || $1::bigint, 'other-' || $1::bigint, '', 'private') RETURNING id)
		INSERT INTO org_members (organization_id, user_id, role) SELECT id, $1, 'owner' FROM org`, other)
	require.NoError(t, err)
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	create := func(name string) func(func(context.Context) error) error {
		return func(hold func(context.Context) error) error {
			return policy.AuthorizeOrgCreateCommitted(ctx, owner, func(ctx context.Context) error {
				if err := hold(ctx); err != nil {
					return err
				}
				_, err := pool.Exec(ctx, `WITH org AS (
						INSERT INTO organizations (name, lower_name, description, visibility)
						VALUES ($2, $2, '', 'private') RETURNING id)
					INSERT INTO org_members (organization_id, user_id, role) SELECT id, $1, 'owner' FROM org`, owner, name)
				return err
			})
		}
	}
	firstErr, secondErr := raceAdmissions(t, ctx, pool, create("winner-org"), create("loser-org"))
	require.NoError(t, firstErr)
	requirePlanLimit(t, secondErr, "organizations")
	var owned int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM org_members WHERE user_id=$1 AND role='owner'`, owner).Scan(&owned))
	require.Equal(t, 3, owned)
}
