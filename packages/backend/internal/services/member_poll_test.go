package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

type permissionPollFixture struct {
	m                *Members
	s                *GitHubSyncedRepoService
	minter           *recordingMinter
	credentials      *callerCredentialFixture
	clock            atomic.Int64
	wakes            atomic.Int32
	memberID, userID int64
}

func newPermissionPollFixture(t *testing.T, handler http.HandlerFunc) *permissionPollFixture {
	t.Helper()
	s, pool, _ := newFetchedFixture(t)
	allowFetched(s)
	f := &permissionPollFixture{s: s, minter: &recordingMinter{}, credentials: &callerCredentialFixture{}}
	f.clock.Store(time.Now().UTC().Truncate(time.Second).Unix())
	s.now = func() time.Time { return time.Unix(f.clock.Load(), 0).UTC() }
	s.budget = NewGitHubResponseBudgetTracker()
	s.budget.now = s.now
	s.budget.registerToken("minted-token", 12, s.now().Add(24*time.Hour))
	f.m = &Members{Pool: pool, Credentials: f.credentials, Minter: f.minter}
	f.m.UseInstallPermissionPolling(s, func() { f.wakes.Add(1) })
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
	require.NoError(t, err)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "writer", LowerUsername: "writer"})
	require.NoError(t, err)
	f.userID = user.ID
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	raw, err := json.Marshal(memberRepository{Owner: "factory", Name: "app", ID: repo.ID})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: raw}))
	err = pool.QueryRow(ctx, `INSERT INTO collaborators(repository_id,user_id,github_id,github_login,permission) VALUES($1,$2,77,'writer','write') RETURNING id`, repo.ID, user.ID).Scan(&f.memberID)
	require.NoError(t, err)
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: "before-poll", UserID: user.ID, Username: "writer", ExpiresAt: time.Now().Add(24 * time.Hour)})
	require.NoError(t, err)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/factory/app/collaborators/writer/permission" || r.Header.Get("Authorization") != "Bearer minted-token" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	return f
}

func (f *permissionPollFixture) assertRoster(t *testing.T, suspended bool, sessions int) {
	t.Helper()
	var got, prohibited bool
	require.NoError(t, f.m.Pool.QueryRow(t.Context(), `SELECT c.suspended_at IS NOT NULL,u.prohibit_login FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, f.memberID).Scan(&got, &prohibited))
	require.Equal(t, suspended, got)
	require.Equal(t, suspended, prohibited)
	require.Equal(t, sessions, fetchedCount(t, f.m.Pool, `SELECT count(*) FROM auth_sessions`))
}

func TestPermissionPollCadenceRetryAndConditionalRevocationPostgres(t *testing.T) {
	var calls atomic.Int32
	f := newPermissionPollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch calls.Add(1) {
		case 1:
			require.Empty(t, r.Header.Get("If-None-Match"))
			w.Header().Set("ETag", `"write"`)
			fmt.Fprint(w, `{"permission":"write","role_name":"write"}`)
		case 2:
			require.Equal(t, `"write"`, r.Header.Get("If-None-Match"))
			w.Header().Set("ETag", `"read"`)
			fmt.Fprint(w, `{"permission":"read","role_name":"read"}`)
		case 3:
			require.Equal(t, `"read"`, r.Header.Get("If-None-Match"))
			w.WriteHeader(http.StatusNotModified)
		case 4:
			require.Equal(t, `"read"`, r.Header.Get("If-None-Match"))
			w.Header().Set("ETag", `"recovered"`)
			fmt.Fprint(w, `{"permission":"write","role_name":"maintain"}`)
		default:
			t.Error("unexpected extra permission read")
		}
	})
	ctx := t.Context()
	streams, err := f.m.RequiredStreams(ctx)
	require.NoError(t, err)
	require.Nil(t, streams[0].LastSuccessAt)
	require.NoError(t, f.m.PollPermissions(ctx))
	f.assertRoster(t, false, 1)
	f.clock.Add(60)
	require.NoError(t, f.m.PollPermissions(ctx))
	require.EqualValues(t, 1, calls.Load())
	require.NoError(t, f.m.RetryStreams(ctx))
	require.EqualValues(t, 1, calls.Load(), "Retry does not perform HTTP")
	require.EqualValues(t, 1, f.wakes.Load())
	require.NoError(t, f.m.PollPermissions(ctx))
	f.assertRoster(t, true, 0)
	f.clock.Add(3540) // Original hourly deadline, not one hour after Retry.
	require.NoError(t, f.m.PollPermissions(ctx))
	require.EqualValues(t, 3, calls.Load())
	f.assertRoster(t, true, 0)
	f.clock.Add(3600)
	require.NoError(t, f.m.PollPermissions(ctx))
	f.assertRoster(t, false, 0)
	streams, err = f.m.RequiredStreams(ctx)
	require.NoError(t, err)
	require.Equal(t, f.s.now(), *streams[0].LastSuccessAt)
	require.Zero(t, f.credentials.jwtCalls, "registry binding avoids a second installation discovery")
	require.Equal(t, []int64{12, 12, 12, 12}, f.minter.installations)
}

func TestPermissionPollFailuresPreserveAccessPostgres(t *testing.T) {
	for _, status := range []int{401, 403, 404, 429, 500, 304, 200} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := newPermissionPollFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				if status == 200 {
					fmt.Fprint(w, `{"role_name":"read"}`)
				}
			})
			require.Error(t, f.m.PollPermissions(t.Context()))
			f.assertRoster(t, false, 1)
			streams, err := f.m.RequiredStreams(t.Context())
			require.NoError(t, err)
			require.Nil(t, streams[0].LastSuccessAt)
			if status == 401 || status == 403 || status == 404 {
				require.Equal(t, "permission", streams[0].Cause)
			}
		})
	}
}

func TestPermissionPollSharedPauseRetainsRetryPostgres(t *testing.T) {
	var calls atomic.Int32
	f := newPermissionPollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(429)
			return
		}
		fmt.Fprint(w, `{"permission":"write"}`)
	})
	ctx := t.Context()
	require.Error(t, f.m.PollPermissions(ctx))
	streams, err := f.m.RequiredStreams(ctx)
	require.NoError(t, err)
	require.Equal(t, f.s.now().Add(time.Minute), *streams[0].RetryAt)
	require.NoError(t, f.m.RetryStreams(ctx))
	f.clock.Add(59)
	require.NoError(t, f.m.PollPermissions(ctx))
	require.Len(t, f.minter.installations, 1, "shared pause applies before minting")
	f.clock.Add(1)
	require.NoError(t, f.m.PollPermissions(ctx))
	require.EqualValues(t, 2, calls.Load())
	f.assertRoster(t, false, 1)
}

func TestPermissionPollRejectsChangedRosterDuringReadPostgres(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	f := newPermissionPollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		require.Empty(t, r.Header.Get("If-None-Match"), "uncommitted read must not install an ETag")
		w.Header().Set("ETag", `"read"`)
		fmt.Fprint(w, `{"permission":"read"}`)
	})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- f.m.PollPermissions(ctx) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("read did not start")
	}
	_, err := f.m.Pool.Exec(ctx, `UPDATE collaborators SET permission='admin' WHERE id=$1`, f.memberID)
	require.NoError(t, err)
	require.NoError(t, f.m.RetryStreams(ctx))    // Retained even while this read is running.
	require.NoError(t, f.m.PollPermissions(ctx)) // Cannot start another concurrent read.
	require.EqualValues(t, 1, calls.Load())
	close(release)
	require.ErrorContains(t, <-done, "member changed")
	f.assertRoster(t, false, 1)
	require.NoError(t, f.m.PollPermissions(ctx))
	require.EqualValues(t, 2, calls.Load())
	f.assertRoster(t, true, 0)
}

func TestPermissionPollRollbackAndRestartPostgres(t *testing.T) {
	var calls atomic.Int32
	f := newPermissionPollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Empty(t, r.Header.Get("If-None-Match"), "failed commit and restart both require a fresh body")
		w.Header().Set("ETag", `"read"`)
		fmt.Fprint(w, `{"permission":"read"}`)
	})
	ctx := t.Context()
	_, err := f.m.Pool.Exec(ctx, `CREATE FUNCTION reject_permission_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test revoke failed'; END $$;
CREATE TRIGGER reject_permission_revoke BEFORE DELETE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION reject_permission_revoke()`)
	require.NoError(t, err)
	require.ErrorContains(t, f.m.PollPermissions(ctx), "test revoke failed")
	f.assertRoster(t, false, 1)
	_, err = f.m.Pool.Exec(ctx, `DROP TRIGGER reject_permission_revoke ON auth_sessions`)
	require.NoError(t, err)
	require.NoError(t, f.m.RetryStreams(ctx))
	require.NoError(t, f.m.PollPermissions(ctx))
	f.assertRoster(t, true, 0)
	f.m.UseInstallPermissionPolling(f.s, func() { f.wakes.Add(1) })
	require.NoError(t, f.m.PollPermissions(ctx))
	f.assertRoster(t, true, 0)
	require.EqualValues(t, 3, calls.Load())
}

func TestPermissionPollUnqualifiedProviderStaysDarkPostgres(t *testing.T) {
	f := newPermissionPollFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("unqualified poll made HTTP request") })
	f.s.install.authorize = nil
	require.NoError(t, f.m.PollPermissions(t.Context()))
	require.Error(t, f.m.RetryStreams(t.Context()))
	_, err := f.m.RequiredStreams(t.Context())
	require.Error(t, err)
	require.Empty(t, f.minter.installations)
}

func TestPermissionPollLowBudgetCadencePostgres(t *testing.T) {
	var calls atomic.Int32
	var reset int64
	f := newPermissionPollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "19")
		w.Header().Set("X-RateLimit-Reset", fmt.Sprint(reset))
		fmt.Fprint(w, `{"permission":"write"}`)
	})
	reset = f.clock.Load() + 10800
	require.NoError(t, f.m.PollPermissions(t.Context()))
	f.clock.Add(3600)
	require.NoError(t, f.m.PollPermissions(t.Context()))
	require.EqualValues(t, 1, calls.Load())
	f.clock.Add(3600)
	require.NoError(t, f.m.PollPermissions(t.Context()))
	require.EqualValues(t, 2, calls.Load())
	f.clock.Add(3600)
	require.NoError(t, f.m.PollPermissions(t.Context()))
	require.EqualValues(t, 3, calls.Load(), "normal hourly cadence resumes at reset")
}

func TestPermissionPollConditionalReadRejectsRebindingPostgres(t *testing.T) {
	for _, binding := range []string{"installation", "local-repository", "roster"} {
		t.Run(binding, func(t *testing.T) {
			var calls atomic.Int32
			entered, release := make(chan struct{}), make(chan struct{})
			f := newPermissionPollFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					w.Header().Set("ETag", `"write"`)
					fmt.Fprint(w, `{"permission":"write"}`)
					return
				}
				require.Equal(t, `"write"`, r.Header.Get("If-None-Match"))
				close(entered)
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				w.WriteHeader(304)
			})
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			require.NoError(t, f.m.PollPermissions(ctx))
			before := f.s.now()
			f.clock.Add(3600)
			done := make(chan error, 1)
			go func() { done <- f.m.PollPermissions(ctx) }()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("conditional read did not start")
			}
			queries := map[string]string{
				"installation":     `UPDATE github_synced_repos SET installation_id=13`,
				"local-repository": `UPDATE install_settings SET value=jsonb_set(value,'{repository_id}','999') WHERE key='github.repository'`,
				"roster":           `UPDATE collaborators SET permission='admin'`,
			}
			_, err := f.m.Pool.Exec(ctx, queries[binding])
			require.NoError(t, err)
			close(release)
			require.Error(t, <-done)
			f.assertRoster(t, false, 1)
			streams, err := f.m.RequiredStreams(ctx)
			require.NoError(t, err)
			if binding == "roster" {
				require.Equal(t, before, *streams[0].LastSuccessAt)
			} else {
				require.Nil(t, streams[0].LastSuccessAt)
			}
		})
	}
}

func TestPermissionPollMintPausePrecedesMinterPostgres(t *testing.T) {
	f := newPermissionPollFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("mint-paused stream reached GitHub") })
	f.s.budget.pauses["installation:12/"+gitHubInstallationTokenPath(12)] = f.s.now().Add(time.Minute)
	require.NoError(t, f.m.RetryStreams(t.Context()))
	require.NoError(t, f.m.PollPermissions(t.Context()))
	require.Empty(t, f.minter.installations)
	streams, err := f.m.RequiredStreams(t.Context())
	require.NoError(t, err)
	require.Equal(t, f.s.now().Add(time.Minute), *streams[0].RetryAt)
}

func TestGitHubSyncObservationAggregatesMemberFailures(t *testing.T) {
	now := time.Now().UTC()
	permission := GitHubResponseFailure(403, nil, now)
	unavailable := GitHubResponseFailure(500, nil, now)
	notInstalled := &pkgerrors.APIError{Code: pkgerrors.CodeGitHubNotInstalled}
	for _, tc := range []struct {
		err  error
		want string
	}{
		{nil, ""},
		{errors.New("read failed"), ""},
		{errors.Join(unavailable, permission), "permission"},
		{errors.Join(permission, unavailable), "permission"},
		{fmt.Errorf("roster: %w", errors.Join(unavailable, permission)), "permission"},
		{errors.Join(permission, notInstalled), "not_installed"},
		{errors.Join(notInstalled, permission), "not_installed"},
	} {
		require.Equal(t, tc.want, gitHubSyncObservation(gitHubPollState{lastError: tc.err}, time.Time{}, now).Cause)
	}
}
