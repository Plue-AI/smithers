package product

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type poolCodec struct{}

func (poolCodec) EncryptString(p string) (string, error) { return "enc:" + p, nil }
func (poolCodec) DecryptString(c string) (string, error) {
	if !strings.HasPrefix(c, "enc:") {
		return "", errors.New("bad ciphertext")
	}
	return strings.TrimPrefix(c, "enc:"), nil
}

type poolRefresher struct {
	mu    sync.Mutex
	err   error
	calls int
	// device sign-in
	pollErr  error
	polls    int
	exchange services.RefreshedTokens
}

func (r *poolRefresher) Refresh(context.Context, string, string) (services.RefreshedTokens, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if r.err != nil {
		return services.RefreshedTokens{}, r.err
	}
	return services.RefreshedTokens{AccessToken: "fresh-access", RefreshToken: "fresh-refresh", ExpiresAt: time.Now().Add(time.Hour)}, nil
}
func (r *poolRefresher) StartDeviceAuthorization(context.Context) (services.CodexDeviceAuthorization, error) {
	return services.CodexDeviceAuthorization{DeviceAuthID: "deviceauth_secret", UserCode: "ABCD-1234", Interval: 5 * time.Second, ExpiresAt: time.Now().Add(10 * time.Minute)}, nil
}
func (r *poolRefresher) PollDeviceAuthorization(_ context.Context, id, code string) (string, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.polls++
	if id != "deviceauth_secret" || code != "ABCD-1234" {
		return "", "", errors.New("wrong device authorization")
	}
	if r.pollErr != nil {
		return "", "", r.pollErr
	}
	return "auth-code", "verifier", nil
}
func (r *poolRefresher) ExchangeDeviceCode(_ context.Context, code, verifier string) (services.RefreshedTokens, error) {
	if code != "auth-code" || verifier != "verifier" {
		return services.RefreshedTokens{}, errors.New("bad exchange")
	}
	return r.exchange, nil
}
func (r *poolRefresher) DeviceVerificationURL() string {
	return "https://auth.example.test/codex/device"
}

type poolFixture struct {
	pool   *pgxpool.Pool
	q      *db.Queries
	svc    *services.ProviderConnectionService
	ref    *poolRefresher
	repoID int64
	alice  *db.User
}

func newPoolFixture(t *testing.T) poolFixture {
	p := servicesBDatabase(t, 0)
	repoID := servicesBRepo(t, p)
	ref := &poolRefresher{}
	q := db.New(p)
	return poolFixture{pool: p, q: q, svc: services.NewProviderConnectionService(q, poolCodec{}, ref, services.WithSubscriptionConnectionsEnabled(true)), ref: ref, repoID: repoID, alice: &db.User{ID: 1, Username: "alice"}}
}

func (f poolFixture) connect(t *testing.T, label string) string {
	t.Helper()
	out, err := f.svc.ConnectForUser(context.Background(), f.alice, services.ConnectProviderInput{Provider: "claude", Label: label, AccessToken: "sk-ant-api03-" + label})
	require.NoError(t, err)
	return out.ID
}

func (f poolFixture) pickLabels(t *testing.T, n int) []string {
	t.Helper()
	var out []string
	for range n {
		pick, err := f.svc.PickForModelCall(context.Background(), 1, f.repoID, "claude", nil)
		require.NoError(t, err)
		require.True(t, pick.Pooled)
		if pick.Connection == nil {
			out = append(out, "-")
			continue
		}
		out = append(out, strings.TrimPrefix(pick.Connection.AccessToken, "sk-ant-api03-"))
	}
	return out
}

func TestProviderPoolRotatesSkipsLimitedAndResets(t *testing.T) {
	f := newPoolFixture(t)
	ctx := context.Background()
	a, b, c := f.connect(t, "a"), f.connect(t, "b"), f.connect(t, "c")
	require.Equal(t, []string{"a", "b", "c", "a", "b", "c"}, f.pickLabels(t, 6), "round-robin in connection order")

	require.NoError(t, f.svc.MarkLimited(ctx, b, time.Now().Add(time.Hour)))
	require.NoError(t, f.svc.MarkLimited(ctx, b, time.Now().Add(time.Minute)), "an earlier reset never shortens a limit")
	require.Equal(t, []string{"a", "c", "a", "c"}, f.pickLabels(t, 4), "a limited account is skipped")

	list, err := f.svc.ListForUser(ctx, f.alice)
	require.NoError(t, err)
	for _, row := range list {
		if row.ID == b {
			require.NotNil(t, row.LimitedUntil)
			require.WithinDuration(t, time.Now().Add(time.Hour), *row.LimitedUntil, time.Minute)
		}
	}

	require.NoError(t, f.svc.MarkLimited(ctx, a, time.Now().Add(30*time.Minute)))
	require.NoError(t, f.svc.MarkLimited(ctx, c, time.Now().Add(2*time.Hour)))
	pick, err := f.svc.PickForModelCall(ctx, 1, f.repoID, "claude", nil)
	require.NoError(t, err)
	require.True(t, pick.Pooled)
	require.Nil(t, pick.Connection, "every account is limited")
	require.False(t, pick.Reconnect)
	require.WithinDuration(t, time.Now().Add(30*time.Minute), pick.NextReset, time.Minute, "the earliest reset")

	_, err = f.pool.Exec(ctx, "UPDATE provider_connections SET limited_until = NOW() - interval '1 second' WHERE id = $1", b)
	require.NoError(t, err)
	require.Equal(t, []string{"b", "b"}, f.pickLabels(t, 2), "an account is usable again once its limit resets")

	pick, err = f.svc.PickForModelCall(ctx, 1, f.repoID, "claude", []string{b})
	require.NoError(t, err)
	require.Nil(t, pick.Connection, "a request never retries an account it already tried")
}

func TestProviderPoolReorderRestartsRotation(t *testing.T) {
	f := newPoolFixture(t)
	a, b, c := f.connect(t, "a"), f.connect(t, "b"), f.connect(t, "c")
	f.pickLabels(t, 2)
	require.NoError(t, f.svc.Reorder(context.Background(), f.alice, "claude", []string{c, a, b}))
	require.Equal(t, []string{"c", "a", "b", "c"}, f.pickLabels(t, 4))
	require.Error(t, f.svc.Reorder(context.Background(), &db.User{ID: 2}, "claude", []string{a}), "only the owner orders")
}

func TestProviderPoolConcurrentPicksSpreadAcrossAccounts(t *testing.T) {
	f := newPoolFixture(t)
	for _, label := range []string{"a", "b", "c"} {
		f.connect(t, label)
	}
	var mu sync.Mutex
	counts := map[string]int{}
	var wg sync.WaitGroup
	for range 30 {
		wg.Go(func() {
			pick, err := f.svc.PickForModelCall(context.Background(), 1, f.repoID, "claude", nil)
			if err != nil || pick.Connection == nil {
				mu.Lock()
				counts["error"]++
				mu.Unlock()
				return
			}
			mu.Lock()
			counts[pick.Connection.AccessToken]++
			mu.Unlock()
		})
	}
	wg.Wait()
	require.Zero(t, counts["error"])
	require.Len(t, counts, 3)
	for token, n := range counts {
		require.GreaterOrEqual(t, n, 4, "%s used %d of 30 times", token, n)
	}
}

func TestProviderPoolSkipsFailedRefreshAndFencesRejection(t *testing.T) {
	f := newPoolFixture(t)
	ctx := context.Background()
	expired := time.Now().Add(-time.Minute)
	// Only a Codex sign-in refreshes; a Claude connection is an API key (#2777).
	oauth, err := f.svc.ConnectForUser(ctx, f.alice, services.ConnectProviderInput{Provider: "codex", Kind: "oauth", Label: "oauth", AccessToken: "old-access", RefreshToken: "old-refresh", AccountID: "acct-1", AccessExpiresAt: &expired})
	require.NoError(t, err)
	fresh, err := f.svc.ConnectForUser(ctx, f.alice, services.ConnectProviderInput{Provider: "codex", Kind: "oauth", Label: "b", AccessToken: "b-access", RefreshToken: "b-refresh", AccountID: "acct-2"})
	require.NoError(t, err)
	b := fresh.ID
	f.ref.err = services.ErrProviderRefreshInvalidGrant
	pick, err := f.svc.PickForModelCall(ctx, 1, f.repoID, "codex", nil)
	require.NoError(t, err)
	require.Equal(t, b, pick.Connection.ConnectionID, "an account whose refresh fails is skipped")
	current, err := f.q.GetProviderConnection(ctx, oauth.ID)
	require.NoError(t, err)
	require.Equal(t, "revoked", current.State)

	require.NoError(t, f.svc.MarkRejected(ctx, b, pick.Connection.RefreshGeneration+1, "401"))
	current, err = f.q.GetProviderConnection(ctx, b)
	require.NoError(t, err)
	require.Equal(t, "active", current.State, "a refusal of an older token generation is ignored")
	require.NoError(t, f.svc.MarkRejected(ctx, b, pick.Connection.RefreshGeneration, "401"))
	pick, err = f.svc.PickForModelCall(ctx, 1, f.repoID, "codex", nil)
	require.NoError(t, err)
	require.True(t, pick.Pooled)
	require.True(t, pick.Reconnect, "every remaining account needs a reconnect")
	require.Nil(t, pick.Connection)
}

func TestProviderPoolScope(t *testing.T) {
	f := newPoolFixture(t)
	ctx := context.Background()
	pick, err := f.svc.PickForModelCall(ctx, 1, f.repoID, "claude", nil)
	require.NoError(t, err)
	require.False(t, pick.Pooled, "no connections: platform credentials")
	has, err := f.svc.HasPool(ctx, 1, f.repoID, "claude")
	require.NoError(t, err)
	require.False(t, has)
	f.connect(t, "a")
	has, err = f.svc.HasPool(ctx, 1, f.repoID, "claude")
	require.NoError(t, err)
	require.True(t, has)
	pick, err = f.svc.PickForModelCall(ctx, 2, f.repoID, "claude", nil)
	require.NoError(t, err)
	require.False(t, pick.Pooled, "another user's run never spends alice's account without a grant")
	pick, err = f.svc.PickForModelCall(ctx, 1, f.repoID, "codex", nil)
	require.NoError(t, err)
	require.False(t, pick.Pooled, "pools never cross providers")
	// With the deployment flag off (the hosted default) the stored account is
	// inert: no pool, no pick.
	disabled := services.NewProviderConnectionService(f.q, poolCodec{}, f.ref)
	has, err = disabled.HasPool(ctx, 1, f.repoID, "claude")
	require.NoError(t, err)
	require.False(t, has, "subscription connections disabled")
	pick, err = disabled.PickForModelCall(ctx, 1, f.repoID, "claude", nil)
	require.NoError(t, err)
	require.False(t, pick.Pooled, "subscription connections disabled")
	// A subscription serves only its account holder's own runs.
	require.NoError(t, f.svc.SetRepositoryPreference(ctx, f.repoID, services.ProviderConnectionPreferenceOrgOnly))
	pick, err = f.svc.PickForModelCall(ctx, 1, f.repoID, "claude", nil)
	require.NoError(t, err)
	require.False(t, pick.Pooled, "org_only never draws on a user's subscription")
	require.NoError(t, f.svc.SetRepositoryPreference(ctx, f.repoID, services.ProviderConnectionPreferencePlatformOnly))
	pick, err = f.svc.PickForModelCall(ctx, 1, f.repoID, "claude", nil)
	require.NoError(t, err)
	require.False(t, pick.Pooled, "platform_only")
}

func TestProviderCodexDeviceLogin(t *testing.T) {
	f := newPoolFixture(t)
	ctx := context.Background()
	old, err := f.svc.ConnectForUser(ctx, f.alice, services.ConnectProviderInput{Provider: "codex", Kind: "oauth", Label: "old", AccessToken: "old-access", RefreshToken: "old-refresh", AccountID: "acct-1"})
	require.NoError(t, err)

	started, err := f.svc.StartCodexDeviceLogin(ctx, f.alice)
	require.NoError(t, err)
	require.Equal(t, "pending", started.State)
	require.Equal(t, "ABCD-1234", started.UserCode)
	require.Equal(t, "https://auth.example.test/codex/device", started.VerificationURI)
	var stored []byte
	require.NoError(t, f.pool.QueryRow(ctx, "SELECT device_auth_id_encrypted FROM provider_connection_device_logins WHERE id=$1", started.ID).Scan(&stored))
	require.Equal(t, "enc:deviceauth_secret", string(stored), "the device authorization is stored encrypted")

	polled, err := f.svc.PollCodexDeviceLogin(ctx, f.alice, started.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", polled.State)
	require.Zero(t, f.ref.polls, "never polls OpenAI before its interval")

	_, err = f.svc.PollCodexDeviceLogin(ctx, &db.User{ID: 2}, started.ID)
	require.Error(t, err, "another user cannot poll")

	due := func() {
		_, err := f.pool.Exec(ctx, "UPDATE provider_connection_device_logins SET next_poll_at = NOW() - interval '1 second' WHERE id=$1", started.ID)
		require.NoError(t, err)
	}
	due()
	f.ref.pollErr = services.ErrCodexDeviceAuthorizationPending
	polled, err = f.svc.PollCodexDeviceLogin(ctx, f.alice, started.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", polled.State)
	require.Equal(t, 1, f.ref.polls)

	due()
	f.ref.pollErr = nil
	f.ref.exchange = services.RefreshedTokens{AccessToken: "new-access", RefreshToken: "new-refresh", ExpiresAt: time.Now().Add(time.Hour), AccountID: "acct-1", AccountEmail: "ada@example.com", Plan: "pro"}
	polled, err = f.svc.PollCodexDeviceLogin(ctx, f.alice, started.ID)
	require.NoError(t, err)
	require.Equal(t, "connected", polled.State)
	require.NotNil(t, polled.Connection)
	require.Equal(t, "codex", polled.Connection.Provider)
	require.Equal(t, "ada@example.com", polled.Connection.Label)
	replaced, err := f.q.GetProviderConnection(ctx, old.ID)
	require.NoError(t, err)
	require.Equal(t, "revoked", replaced.State, "reconnecting an account replaces its older connection")

	again, err := f.svc.PollCodexDeviceLogin(ctx, f.alice, started.ID)
	require.NoError(t, err)
	require.Equal(t, "connected", again.State)
	require.Equal(t, 2, f.ref.polls, "a finished sign-in answers from storage")

	expired, err := f.svc.StartCodexDeviceLogin(ctx, f.alice)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, "UPDATE provider_connection_device_logins SET expires_at = NOW() - interval '1 second' WHERE id=$1", expired.ID)
	require.NoError(t, err)
	polled, err = f.svc.PollCodexDeviceLogin(ctx, f.alice, expired.ID)
	require.NoError(t, err)
	require.Equal(t, "expired", polled.State)
}

func TestProviderAccountReplacementOnlyRevokesOlderConnections(t *testing.T) {
	f := newPoolFixture(t)
	ctx := context.Background()
	older, err := f.svc.ConnectForUser(ctx, f.alice, services.ConnectProviderInput{Provider: "codex", Kind: "oauth", Label: "older", AccessToken: "a1", RefreshToken: "r1", AccountID: "acct"})
	require.NoError(t, err)
	newer, err := f.svc.ConnectForUser(ctx, f.alice, services.ConnectProviderInput{Provider: "codex", Kind: "oauth", Label: "newer", AccessToken: "a2", RefreshToken: "r2", AccountID: "acct"})
	require.NoError(t, err)
	user := pgtypeUser(1)
	n, err := f.q.RevokeOtherUserProviderAccountConnections(ctx, db.RevokeOtherUserProviderAccountConnectionsParams{UserID: user, Provider: "codex", AccountID: "acct", KeepID: older.ID})
	require.NoError(t, err)
	require.Zero(t, n, "an older sign-in never revokes a newer one")
	n, err = f.q.RevokeOtherUserProviderAccountConnections(ctx, db.RevokeOtherUserProviderAccountConnectionsParams{UserID: user, Provider: "codex", AccountID: "acct", KeepID: newer.ID})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
}

func TestProviderDeviceLoginExpiryWaitsForAHeldPoll(t *testing.T) {
	f := newPoolFixture(t)
	ctx := context.Background()
	started, err := f.svc.StartCodexDeviceLogin(ctx, f.alice)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, "UPDATE provider_connection_device_logins SET expires_at = NOW() - interval '1 second', poll_lease_until = NOW() + interval '1 minute' WHERE id=$1", started.ID)
	require.NoError(t, err)
	var state string
	polled, err := f.svc.PollCodexDeviceLogin(ctx, f.alice, started.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", polled.State, "the browser keeps polling while a poll holds the sign-in")
	require.NoError(t, f.pool.QueryRow(ctx, "SELECT state FROM provider_connection_device_logins WHERE id=$1", started.ID).Scan(&state))
	require.Equal(t, "pending", state, "the poll holding the lease finishes the sign-in")
}

func TestProviderWebConnectionServesEveryRepositoryOfItsOwner(t *testing.T) {
	f := newPoolFixture(t)
	ctx := context.Background()
	var orgRepo int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO organizations(name, lower_name) VALUES('acme','acme') RETURNING id`).Scan(new(int64)))
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO repositories(org_id,name,lower_name) VALUES((SELECT id FROM organizations WHERE lower_name='acme'),'app','app') RETURNING id`).Scan(&orgRepo))
	f.connect(t, "cli")
	has, err := f.svc.HasPool(ctx, 1, orgRepo, "claude")
	require.NoError(t, err)
	require.False(t, has, "a connection without a grant serves only the owner's repositories")
	_, err = f.svc.ConnectForUser(ctx, f.alice, services.ConnectProviderInput{Provider: "claude", Label: "web-00000000-0000-0000-0000-000000000001", AccessToken: "sk-ant-api03-key"})
	require.NoError(t, err)
	pick, err := f.svc.PickForModelCall(ctx, 1, orgRepo, "claude", nil)
	require.NoError(t, err)
	require.NotNil(t, pick.Connection)
	require.Equal(t, "api_key", pick.Connection.Kind)
	pick, err = f.svc.PickForModelCall(ctx, 2, orgRepo, "claude", nil)
	require.NoError(t, err)
	require.False(t, pick.Pooled, "never another user's scope")
}

func pgtypeUser(id int64) pgtype.Int8 { return pgtype.Int8{Int64: id, Valid: true} }
