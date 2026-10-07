package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func newRefFixture(t *testing.T) (*GitHubSyncedRepoService, *pgxpool.Pool, db.GithubSyncedRepo, db.GithubMainPull) {
	t.Helper()
	s, pool, source := newFetchedFixture(t)
	q, ctx := db.New(pool), t.Context()
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ref-owner", LowerUsername: "ref-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "ref-repo", LowerName: "ref-repo", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE repositories SET mirror_destination='factory/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	_, err = q.RequestGithubMainPull(ctx, repo.ID)
	require.NoError(t, err)
	claims, err := q.ClaimGithubMainPulls(ctx, 1, 900)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	return s, pool, source, claims[0]
}

func nextRefClaim(t *testing.T, pool *pgxpool.Pool, previous db.GithubMainPull) db.GithubMainPull {
	t.Helper()
	q, ctx := db.New(pool), t.Context()
	n, err := q.FinishGithubMainPull(ctx, db.FinishGithubMainPullParams{RepositoryID: previous.RepositoryID, Claim: previous.Claim, State: "synced"})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	_, err = q.RequestGithubMainPull(ctx, previous.RepositoryID)
	require.NoError(t, err)
	claims, err := q.ClaimGithubMainPulls(ctx, 1, 900)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	return claims[0]
}

func TestGitHubRefsAdmissionAndRecovery(t *testing.T) {
	s, pool, _, claim := newRefFixture(t)
	ctx := t.Context()
	_, err := s.prepareRefRead(ctx, claim)
	require.Error(t, err, "missing authority must refuse before reading")
	allowFetched(s)
	commit, err := s.prepareRefRead(ctx, claim)
	require.NoError(t, err)
	refs := map[string]string{"refs/heads/main": pullOld, "refs/heads/smithers/one": pullNew}
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_ref_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.principal_id='refs' THEN RAISE EXCEPTION 'ref admission refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_ref_admission BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_ref_admission()`)
	require.NoError(t, err)
	require.ErrorContains(t, commit(ctx, "factory", "app", "main", refs), "ref admission refused")
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_ref_admission ON product_job_requests`)
	require.NoError(t, err)
	require.NoError(t, commit(ctx, "factory", "app", "main", refs))
	require.NoError(t, commit(ctx, "factory", "app", "main", refs))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	// A different result cannot reuse one claim's identity.
	require.Error(t, commit(ctx, "factory", "app", "main", map[string]string{"refs/heads/main": pullNew}))
	stop := runFetchedFixture(t, s)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_dispatches WHERE attempt>0`) > 0
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='accepted'`))
	claim = nextRefClaim(t, pool, claim)
	commit, err = s.prepareRefRead(ctx, claim)
	require.NoError(t, err)
	require.NoError(t, commit(ctx, "factory", "app", "main", refs))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`), "an unchanged poll reuses its latest delivery")

	// B then A are distinct observations, even though A was already delivered
	// by an earlier poll. A complete empty listing is retained too.
	for _, snapshot := range []map[string]string{{"refs/heads/main": pullNew}, refs, {}} {
		claim = nextRefClaim(t, pool, claim)
		commit, err = s.prepareRefRead(ctx, claim)
		require.NoError(t, err)
		require.NoError(t, commit(ctx, "factory", "app", "main", snapshot))
	}
	require.Equal(t, 4, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	// Deliberately invert timestamps; claim ordering must remain authoritative.
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET created_at=now()-make_interval(secs=>(payload->>'ref_claim')::int)`)
	require.NoError(t, err)
	fresh := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, fresh.ConfigureInstallSync(pool))
	allowFetched(fresh)
	var attempts atomic.Int32
	fresh.install.consumers[gitHubRefs] = func(ctx context.Context, tx pgx.Tx, fact gitHubFetchedObject) (json.RawMessage, error) {
		attempts.Add(1)
		_, err := tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('refs-test',jsonb_build_array($1::jsonb)) ON CONFLICT(key) DO UPDATE SET value=install_settings.value || excluded.value`, fact.Object)
		return json.RawMessage(`{}`), err
	}
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_ref_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='operation.completed' THEN RAISE EXCEPTION 'ref ack refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_ref_ack BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_ref_ack()`)
	require.NoError(t, err)
	stop = runFetchedFixture(t, fresh)
	require.Eventually(t, func() bool { return attempts.Load() > 0 }, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM install_settings WHERE key='refs-test'`))
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_ref_ack ON product_job_events`)
	require.NoError(t, err)
	stop = runFetchedFixture(t, fresh)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='completed'`) == 4
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	var effects []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key='refs-test'`).Scan(&effects))
	require.JSONEq(t, fmt.Sprintf(`[{"branch":"main","refs":{"refs/heads/main":%q,"refs/heads/smithers/one":%q}},{"branch":"main","refs":{"refs/heads/main":%q}},{"branch":"main","refs":{"refs/heads/main":%q,"refs/heads/smithers/one":%q}},{"branch":"main","refs":{}}]`, pullOld, pullNew, pullNew, pullOld, pullNew), string(effects))
}

func TestGitHubRefsRecheckSourceAndClaim(t *testing.T) {
	for _, change := range []string{"installation", "github-id", "source-name", "destination", "default-branch", "disabled", "new-claim", "expired", "authority", "request-source"} {
		t.Run(change, func(t *testing.T) {
			s, pool, source, claim := newRefFixture(t)
			ctx := t.Context()
			allowFetched(s)
			commit, err := s.prepareRefRead(ctx, claim)
			require.NoError(t, err)
			query, arg := "", source.ID
			switch change {
			case "installation":
				query = `UPDATE github_synced_repos SET installation_id=13 WHERE id=$1`
			case "github-id":
				query = `UPDATE github_synced_repos SET github_repository_id=100 WHERE id=$1`
			case "source-name":
				query = `UPDATE github_synced_repos SET owner_login='renamed' WHERE id=$1`
			case "disabled":
				query = `UPDATE github_synced_repos SET sync_metadata=false WHERE id=$1`
			case "destination":
				query, arg = `UPDATE repositories SET mirror_destination='other/app' WHERE id=$1`, claim.RepositoryID
			case "default-branch":
				query, arg = `UPDATE repositories SET default_bookmark='other' WHERE id=$1`, claim.RepositoryID
			case "new-claim":
				query, arg = `UPDATE github_main_pulls SET claim=claim+1 WHERE repository_id=$1`, claim.RepositoryID
			case "expired":
				query, arg = `UPDATE github_main_pulls SET lease_expires_at=now()-interval '1 second' WHERE repository_id=$1`, claim.RepositoryID
			case "authority":
				s.install.authorize = func(context.Context, db.GithubSyncedRepo) error { return errors.New("authority revoked") }
			}
			if query != "" {
				_, err = pool.Exec(ctx, query, arg)
				require.NoError(t, err)
			}
			owner := "factory"
			if change == "request-source" {
				owner = "other"
			}
			require.Error(t, commit(ctx, owner, "app", "main", map[string]string{"refs/heads/main": pullOld}))
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
		})
	}
}

func TestGitHubRefSnapshotValidation(t *testing.T) {
	for _, snapshot := range []gitHubRefSnapshot{
		{Branch: "", Refs: map[string]string{}},
		{Branch: "main"},
		{Branch: "main", Refs: map[string]string{"refs/tags/version": pullOld}},
		{Branch: "main", Refs: map[string]string{"refs/heads/other": pullOld}},
		{Branch: "main", Refs: map[string]string{"refs/heads/smithers/": pullOld}},
		{Branch: "main", Refs: map[string]string{"refs/heads/main": "bad"}},
		{Branch: "main", Refs: map[string]string{"refs/heads/main": "0000000000000000000000000000000000000000"}},
	} {
		require.Error(t, validateRefSnapshot(snapshot))
	}
	require.NoError(t, validateRefSnapshot(gitHubRefSnapshot{Branch: "main", Refs: map[string]string{}}))
	_, err := parseRemoteRefs(pullOld + " refs/heads/main\n" + pullNew + " refs/heads/main\n")
	require.ErrorContains(t, err, "conflicting")
}

func TestGitHubRefsLeaseMustSurviveLockWait(t *testing.T) {
	s, pool, _, claim := newRefFixture(t)
	ctx := t.Context()
	allowFetched(s)
	_, err := pool.Exec(ctx, `UPDATE github_main_pulls SET lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE repository_id=$1`, claim.RepositoryID)
	require.NoError(t, err)
	commit, err := s.prepareRefRead(ctx, claim)
	require.NoError(t, err)
	locker, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer locker.Rollback(context.Background())
	_, err = locker.Exec(ctx, `SELECT repository_id FROM github_main_pulls WHERE repository_id=$1 FOR UPDATE`, claim.RepositoryID)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- commit(ctx, "factory", "app", "main", map[string]string{"refs/heads/main": pullOld}) }()
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT claim FROM github_main_pulls%'`) > 0
	}, time.Second, 10*time.Millisecond)
	require.Eventually(t, func() bool {
		var expired bool
		err := pool.QueryRow(ctx, `SELECT lease_expires_at<=clock_timestamp() FROM github_main_pulls WHERE repository_id=$1`, claim.RepositoryID).Scan(&expired)
		require.NoError(t, err)
		return expired
	}, 3*time.Second, 10*time.Millisecond)
	require.NoError(t, locker.Commit(ctx))
	select {
	case err := <-done:
		require.Error(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("ref admission did not finish")
	}
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
}

func TestGitHubRefsDeliveryRechecksLocalRepository(t *testing.T) {
	for _, change := range []string{"destination", "branch"} {
		t.Run(change, func(t *testing.T) {
			s, pool, _, claim := newRefFixture(t)
			ctx := t.Context()
			allowFetched(s)
			commit, err := s.prepareRefRead(ctx, claim)
			require.NoError(t, err)
			require.NoError(t, commit(ctx, "factory", "app", "main", map[string]string{"refs/heads/main": pullOld}))
			query := `UPDATE repositories SET mirror_destination='other/app' WHERE id=$1`
			if change == "branch" {
				query = `UPDATE repositories SET default_bookmark='other' WHERE id=$1`
			}
			_, err = pool.Exec(ctx, query, claim.RepositoryID)
			require.NoError(t, err)
			var calls atomic.Int32
			s.install.consumers[gitHubRefs] = func(context.Context, pgx.Tx, gitHubFetchedObject) (json.RawMessage, error) {
				calls.Add(1)
				return json.RawMessage(`{}`), nil
			}
			stop := runFetchedFixture(t, s)
			require.Eventually(t, func() bool {
				return fetchedCount(t, pool, `SELECT count(*) FROM product_job_dispatches WHERE attempt>0`) > 0
			}, 3*time.Second, 10*time.Millisecond)
			stop()
			require.Zero(t, calls.Load())
			require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='accepted'`))
		})
	}
}

func TestInstallMainWorkerRequiresRefDeliveryAdmission(t *testing.T) {
	s, pool, _, claim := newRefFixture(t)
	allowFetched(s)
	ctx := t.Context()
	q := db.New(pool)
	_, err := q.FinishGithubMainPull(ctx, db.FinishGithubMainPullParams{RepositoryID: claim.RepositoryID, Claim: claim.Claim, State: "failed"})
	require.NoError(t, err)
	host := &fakeMainPullHost{bookmarks: map[string]string{"main": pullOld}}
	main := NewGitHubMainPullService(q, host, &fixtureTokens{}, nil)
	qualifyMainPullFixture(main)
	main.refReadAdmission = s
	reads := 0
	main.lsRemote = func(_ context.Context, _ string, patterns ...string) (map[string]string, error) {
		reads++
		require.Equal(t, []string{"refs/heads/main", "refs/heads/smithers/*"}, patterns)
		return map[string]string{"refs/heads/main": pullOld, "refs/heads/smithers/todo": pullNew}, nil
	}
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_worker_refs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.principal_id='refs' THEN RAISE EXCEPTION 'ref admission refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_worker_refs BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_worker_refs()`)
	require.NoError(t, err)
	require.NoError(t, main.PollOnce(ctx))
	row, err := q.GetGithubMainPull(ctx, claim.RepositoryID)
	require.NoError(t, err)
	require.Equal(t, "failed", row.State)
	require.Contains(t, row.LastError, "ref admission refused")
	require.False(t, row.LastSyncedAt.Valid)
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_worker_refs ON product_job_requests`)
	require.NoError(t, err)
	_, err = main.Request(ctx, claim.RepositoryID)
	require.NoError(t, err)
	require.NoError(t, main.PollOnce(ctx))
	row, err = q.GetGithubMainPull(ctx, claim.RepositoryID)
	require.NoError(t, err)
	require.Equal(t, "synced", row.State)
	require.True(t, row.LastSyncedAt.Valid)
	require.Equal(t, 2, reads)
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state='accepted' AND principal_id='refs'`))
	require.Empty(t, host.received)
}
