package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// plainCodec is a reversible stand-in for the AES-GCM codec.
type plainCodec struct{}

func (plainCodec) EncryptString(p string) (string, error) { return "enc:" + p, nil }
func (plainCodec) DecryptString(c string) (string, error) {
	if !strings.HasPrefix(c, "enc:") {
		return "", errors.New("bad ciphertext")
	}
	return strings.TrimPrefix(c, "enc:"), nil
}

type revokingCodec struct {
	plainCodec
	revoke func()
}

func (c revokingCodec) DecryptString(ciphertext string) (string, error) {
	if c.revoke != nil {
		c.revoke()
	}
	return c.plainCodec.DecryptString(ciphertext)
}

type fakeProviderConnectionQuerier struct {
	rows       map[string]db.ProviderConnection
	grants     []db.ProviderConnectionGrant
	repos      map[int64]db.Repository
	members    map[[2]int64]string
	orgs       map[string]db.Organization
	preference map[int64]string
	seq        int
	failures   []db.MarkProviderConnectionRefreshFailureParams
}

func newFakePCQ() *fakeProviderConnectionQuerier {
	return &fakeProviderConnectionQuerier{rows: map[string]db.ProviderConnection{}, repos: map[int64]db.Repository{}, members: map[[2]int64]string{}, orgs: map[string]db.Organization{}, preference: map[int64]string{}}
}

func (f *fakeProviderConnectionQuerier) CreateProviderConnection(_ context.Context, a db.CreateProviderConnectionParams) (db.ProviderConnection, error) {
	f.seq++
	row := db.ProviderConnection{ID: "conn-" + string(rune('0'+f.seq)), OwnerType: a.OwnerType, UserID: a.UserID, OrgID: a.OrgID, Provider: a.Provider, Kind: a.Kind, Label: a.Label, AccountEmail: a.AccountEmail, AccountID: a.AccountID, Plan: a.Plan, AccessTokenEncrypted: a.AccessTokenEncrypted, RefreshTokenEncrypted: a.RefreshTokenEncrypted, AccessExpiresAt: a.AccessExpiresAt, NextRefreshAt: a.NextRefreshAt, State: "active", CreatedBy: a.CreatedBy, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	f.rows[row.ID] = row
	return row, nil
}
func (f *fakeProviderConnectionQuerier) GetProviderConnection(_ context.Context, id string) (db.ProviderConnection, error) {
	row, ok := f.rows[id]
	if !ok {
		return db.ProviderConnection{}, pgx.ErrNoRows
	}
	return row, nil
}
func (f *fakeProviderConnectionQuerier) ListUserProviderConnections(_ context.Context, userID pgtype.Int8) ([]db.ProviderConnection, error) {
	var out []db.ProviderConnection
	for _, r := range f.rows {
		if r.OwnerType == "user" && r.UserID == userID {
			out = append(out, r)
		}
	}
	return out, nil
}
func (f *fakeProviderConnectionQuerier) ListOrgProviderConnections(_ context.Context, orgID pgtype.Int8) ([]db.ProviderConnection, error) {
	var out []db.ProviderConnection
	for _, r := range f.rows {
		if r.OwnerType == "org" && r.OrgID == orgID {
			out = append(out, r)
		}
	}
	return out, nil
}
func (f *fakeProviderConnectionQuerier) RevokeProviderConnection(_ context.Context, a db.RevokeProviderConnectionParams) (int64, error) {
	r := f.rows[a.ID]
	r.State = "revoked"
	r.LastError = a.LastError
	f.rows[a.ID] = r
	return 1, nil
}
func (f *fakeProviderConnectionQuerier) UpdateProviderConnectionTokens(_ context.Context, a db.UpdateProviderConnectionTokensParams) error {
	r := f.rows[a.ID]
	if r.State == "revoked" || r.RefreshGeneration != a.RefreshGeneration {
		return nil
	}
	r.AccessTokenEncrypted, r.RefreshTokenEncrypted, r.AccessExpiresAt, r.NextRefreshAt = a.AccessTokenEncrypted, a.RefreshTokenEncrypted, a.AccessExpiresAt, a.NextRefreshAt
	r.State, r.RefreshFailures, r.LastError = "active", 0, ""
	r.RefreshLeaseUntil = pgtype.Timestamptz{}
	r.LastRefreshAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	f.rows[a.ID] = r
	return nil
}
func (f *fakeProviderConnectionQuerier) MarkProviderConnectionRefreshFailure(_ context.Context, a db.MarkProviderConnectionRefreshFailureParams) error {
	f.failures = append(f.failures, a)
	r := f.rows[a.ID]
	if r.State == "revoked" || r.RefreshGeneration != a.RefreshGeneration {
		return nil
	}
	r.RefreshLeaseUntil = pgtype.Timestamptz{}
	r.RefreshFailures, r.NextRefreshAt, r.LastError, r.State = a.RefreshFailures, a.NextRefreshAt, a.LastError, a.State
	f.rows[a.ID] = r
	return nil
}
func (f *fakeProviderConnectionQuerier) ClaimProviderConnectionForRefresh(_ context.Context, a db.ClaimProviderConnectionForRefreshParams) (db.ProviderConnection, error) {
	for id, r := range f.rows {
		if (r.State != "active" && !(a.ConnectionID != "" && r.State == "refresh_failed")) || len(r.RefreshTokenEncrypted) == 0 {
			continue
		}
		if a.ConnectionID != "" && a.ConnectionID != id {
			continue
		}
		if r.RefreshLeaseUntil.Valid && r.RefreshLeaseUntil.Time.After(time.Now()) {
			continue
		}
		if a.ConnectionID == "" && r.AccessExpiresAt.Valid && r.AccessExpiresAt.Time.After(a.ExpiresBefore) {
			continue
		}
		if a.ConnectionID == "" && r.NextRefreshAt.Valid && r.NextRefreshAt.Time.After(time.Now()) {
			continue
		}
		r.RefreshLeaseUntil = pgtype.Timestamptz{Time: a.LeaseUntil, Valid: true}
		r.RefreshGeneration++
		f.rows[id] = r
		return r, nil
	}
	return db.ProviderConnection{}, pgx.ErrNoRows
}
func (f *fakeProviderConnectionQuerier) eligible(userID int64, provider string, repositoryID int64, excluded []string) []db.ProviderConnection {
	repo := f.repos[repositoryID]
	var out []db.ProviderConnection
	for _, r := range f.rows {
		if r.OwnerType != "user" || r.UserID.Int64 != userID || r.Provider != provider || r.State != "active" || slices.Contains(excluded, r.ID) {
			continue
		}
		if repo.UserID.Valid && repo.UserID.Int64 == userID {
			out = append(out, r)
			continue
		}
		for _, g := range f.grants {
			if g.ConnectionID == r.ID && (g.AllRepositories || (g.RepositoryID.Valid && g.RepositoryID.Int64 == repositoryID) || (g.OrgID.Valid && repo.OrgID.Valid && g.OrgID.Int64 == repo.OrgID.Int64)) {
				out = append(out, r)
				break
			}
		}
	}
	return out
}
func (f *fakeProviderConnectionQuerier) ProviderConnectionPoolStatus(_ context.Context, a db.ProviderConnectionPoolStatusParams) (db.ProviderConnectionPoolStatusRow, error) {
	n := int64(len(f.eligible(a.UserID, a.Provider, a.RepositoryID, nil)))
	return db.ProviderConnectionPoolStatusRow{Active: n, Usable: n}, nil
}
func (f *fakeProviderConnectionQuerier) PickProviderConnection(_ context.Context, a db.PickProviderConnectionParams) (db.ProviderConnection, error) {
	rows := f.eligible(a.UserID, a.Provider, a.RepositoryID, a.Excluded)
	if len(rows) == 0 {
		return db.ProviderConnection{}, pgx.ErrNoRows
	}
	return rows[0], nil
}
func (f *fakeProviderConnectionQuerier) AddProviderConnectionGrant(_ context.Context, a db.AddProviderConnectionGrantParams) (db.ProviderConnectionGrant, error) {
	g := db.ProviderConnectionGrant{ID: int64(len(f.grants) + 1), ConnectionID: a.ConnectionID, RepositoryID: a.RepositoryID, OrgID: a.OrgID, AllRepositories: a.AllRepositories}
	f.grants = append(f.grants, g)
	return g, nil
}
func (f *fakeProviderConnectionQuerier) ListProviderConnectionGrants(_ context.Context, id string) ([]db.ProviderConnectionGrant, error) {
	var out []db.ProviderConnectionGrant
	for _, g := range f.grants {
		if g.ConnectionID == id {
			out = append(out, g)
		}
	}
	return out, nil
}
func (f *fakeProviderConnectionQuerier) DeleteProviderConnectionGrant(_ context.Context, a db.DeleteProviderConnectionGrantParams) (int64, error) {
	for i, g := range f.grants {
		if g.ID == a.ID && g.ConnectionID == a.ConnectionID {
			f.grants = append(f.grants[:i], f.grants[i+1:]...)
			return 1, nil
		}
	}
	return 0, nil
}
func (f *fakeProviderConnectionQuerier) UpsertRepositoryProviderConnectionPreference(_ context.Context, a db.UpsertRepositoryProviderConnectionPreferenceParams) error {
	f.preference[a.RepositoryID] = a.Preference
	return nil
}
func (f *fakeProviderConnectionQuerier) GetRepositoryProviderConnectionPreference(_ context.Context, id int64) (string, error) {
	p, ok := f.preference[id]
	if !ok {
		return "", pgx.ErrNoRows
	}
	return p, nil
}
func (f *fakeProviderConnectionQuerier) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	r, ok := f.repos[id]
	if !ok {
		return db.Repository{}, pgx.ErrNoRows
	}
	return r, nil
}
func (f *fakeProviderConnectionQuerier) GetOrgByLowerName(_ context.Context, name string) (db.Organization, error) {
	o, ok := f.orgs[name]
	if !ok {
		return db.Organization{}, pgx.ErrNoRows
	}
	return o, nil
}
func (f *fakeProviderConnectionQuerier) GetOrgMember(_ context.Context, a db.GetOrgMemberParams) (db.OrgMember, error) {
	role, ok := f.members[[2]int64{a.OrganizationID, a.UserID}]
	if !ok {
		return db.OrgMember{}, pgx.ErrNoRows
	}
	return db.OrgMember{OrganizationID: a.OrganizationID, UserID: a.UserID, Role: role}, nil
}

type stubRefresher struct {
	tokens RefreshedTokens
	err    error
	calls  int
}

func (s *stubRefresher) Refresh(context.Context, string, string) (RefreshedTokens, error) {
	s.calls++
	return s.tokens, s.err
}

func newPCService(q *fakeProviderConnectionQuerier, r ProviderTokenRefresher) *ProviderConnectionService {
	return NewProviderConnectionService(q, plainCodec{}, r, WithSubscriptionConnectionsEnabled(true))
}

func TestProviderConnection_ConnectValidatesKindsAndTokens(t *testing.T) {
	q := newFakePCQ()
	svc := newPCService(q, nil)
	actor := &db.User{ID: 7, Username: "will"}

	_, err := svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "claude", AccessToken: "not-an-api-key"})
	require.Error(t, err, "a Claude connection must be an Anthropic API key")

	_, err = svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "codex", AccessToken: "acc", RefreshToken: "ref"})
	require.Error(t, err, "codex needs the account id")

	out, err := svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-api03-abc"})
	require.NoError(t, err)
	assert.Equal(t, ProviderConnectionKindAPIKey, out.Kind)
	assert.False(t, out.HasRefreshToken)
	assert.Equal(t, "active", out.State)

	exp := time.Now().Add(time.Hour)
	out, err = svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "codex", AccessToken: "acc", RefreshToken: "ref", AccountID: "acct_1", AccessExpiresAt: &exp})
	require.NoError(t, err)
	assert.Equal(t, ProviderConnectionKindOAuth, out.Kind)
	assert.True(t, out.HasRefreshToken)
	row := q.rows[out.ID]
	assert.Equal(t, "enc:acc", string(row.AccessTokenEncrypted), "tokens are stored through the codec")
	assert.Equal(t, "enc:ref", string(row.RefreshTokenEncrypted))
}

// #2777: no shape of Claude subscription login is accepted or stored, even
// with subscription connections enabled and whatever provider it is labeled
// with, so the Codex refresher never sends a Claude refresh token to OpenAI.
func TestProviderConnection_RefusesEveryClaudeSubscriptionToken(t *testing.T) {
	q := newFakePCQ()
	svc := newPCService(q, nil)
	actor := &db.User{ID: 7}
	for name, in := range map[string]ConnectProviderInput{
		"setup token":            {Provider: "claude", AccessToken: "sk-ant-oat01-setup"},
		"setup_token kind":       {Provider: "claude", Kind: "setup_token", AccessToken: "sk-ant-oat01-setup"},
		"oauth pair":             {Provider: "claude", Kind: "oauth", AccessToken: "sk-ant-oat01-access", RefreshToken: "sk-ant-ort01-refresh"},
		"oauth inferred":         {Provider: "claude", AccessToken: "sk-ant-oat01-access", RefreshToken: "sk-ant-ort01-refresh"},
		"oauth as api_key":       {Provider: "claude", Kind: "api_key", AccessToken: "sk-ant-oat01-access"},
		"api key with a refresh": {Provider: "claude", AccessToken: "sk-ant-api03-key", RefreshToken: "sk-ant-ort01-refresh"},
		"claude-code alias":      {Provider: "claude-code", AccessToken: "sk-ant-oat01-setup"},
		"codex-labeled pair":     {Provider: "codex", Kind: "oauth", AccessToken: "sk-ant-oat01-access", RefreshToken: "sk-ant-ort01-refresh", AccountID: "acct"},
		"codex-labeled access":   {Provider: "codex", AccessToken: "sk-ant-oat01-access", RefreshToken: "rt", AccountID: "acct"},
		"codex-labeled refresh":  {Provider: "chatgpt", AccessToken: "at", RefreshToken: "sk-ant-ort01-refresh", AccountID: "acct"},
	} {
		_, err := svc.ConnectForUser(context.Background(), actor, in)
		require.Error(t, err, name)
		assert.Equal(t, errClaudeSubscriptionToken().Error(), err.Error(), name)
	}
	_, err := svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "codex", Kind: "setup_token", AccessToken: "at", RefreshToken: "rt", AccountID: "acct"})
	require.ErrorContains(t, err, "a codex connection is a ChatGPT sign-in (kind oauth)")
	assert.Empty(t, q.rows, "nothing is stored")
}

// #2777: a row holding a Claude token, under any provider label, is never
// handed to the pool, and its refresh token never reaches a refresher.
func TestProviderConnection_NeverMaterializesAStoredClaudeSubscriptionToken(t *testing.T) {
	q := newFakePCQ()
	refresher := &stubRefresher{tokens: RefreshedTokens{AccessToken: "fresh", ExpiresAt: time.Now().Add(time.Hour)}}
	svc := NewProviderConnectionService(q, plainCodec{}, refresher, WithSubscriptionConnectionsEnabled(true))
	for _, row := range []db.ProviderConnection{
		{ID: "setup", Provider: "claude", Kind: "setup_token", AccessTokenEncrypted: []byte("enc:sk-ant-oat01-setup")},
		{ID: "mislabeled", Provider: "claude", Kind: "api_key", AccessTokenEncrypted: []byte("enc:sk-ant-oat01-access")},
		{ID: "codex-access", Provider: "codex", Kind: "oauth", AccessTokenEncrypted: []byte("enc:sk-ant-oat01-access"), RefreshTokenEncrypted: []byte("enc:rt")},
		{ID: "codex-refresh", Provider: "codex", Kind: "oauth", AccessTokenEncrypted: []byte("enc:at"), RefreshTokenEncrypted: []byte("enc:sk-ant-ort01-refresh"),
			AccessExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true}},
		{ID: "codex-session", Provider: "codex", Kind: "oauth", AccessTokenEncrypted: []byte("enc:sk-ant-sid01-session"), RefreshTokenEncrypted: []byte("enc:rt")},
	} {
		resolved, err := svc.materialize(context.Background(), row)
		require.Error(t, err, row.ID)
		assert.Nil(t, resolved, row.ID)
	}
	resolved, err := svc.materialize(context.Background(), db.ProviderConnection{ID: "key", Provider: "claude", Kind: "api_key", AccessTokenEncrypted: []byte("enc:sk-ant-api03-key")})
	require.NoError(t, err)
	assert.Equal(t, "sk-ant-api03-key", resolved.AccessToken)
	resolved, err = svc.materialize(context.Background(), db.ProviderConnection{ID: "codex", Provider: "codex", Kind: "oauth", AccessTokenEncrypted: []byte("enc:at"), RefreshTokenEncrypted: []byte("enc:rt")})
	require.NoError(t, err)
	assert.Equal(t, "at", resolved.AccessToken)
	// The background refresh never sends a Claude refresh token to OpenAI.
	require.Error(t, svc.refreshClaimedRow(context.Background(), db.ProviderConnection{ID: "codex-refresh", Provider: "codex", Kind: "oauth",
		AccessTokenEncrypted: []byte("enc:at"), RefreshTokenEncrypted: []byte("enc:sk-ant-ort01-refresh")}))
	assert.Zero(t, refresher.calls, "no Claude token reaches a refresher")
}

func TestProviderConnection_WebRequestIsIdempotentAndAccountScoped(t *testing.T) {
	q := newFakePCQ()
	q.repos[2] = db.Repository{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	svc := newPCService(q, nil)
	alice, bob := &db.User{ID: 7}, &db.User{ID: 8}
	first, err := svc.ConnectForUser(context.Background(), alice, ConnectProviderInput{Provider: "claude", Label: "web-request-1", AccessToken: "sk-ant-api03-first"})
	require.NoError(t, err)
	replayed, err := svc.ConnectForUser(context.Background(), alice, ConnectProviderInput{Provider: "claude", Label: "web-request-1", AccessToken: "sk-ant-api03-second"})
	require.NoError(t, err)
	assert.Equal(t, first.ID, replayed.ID)
	assert.Equal(t, 1, len(q.rows))
	assert.Equal(t, "enc:sk-ant-api03-first", string(q.rows[first.ID].AccessTokenEncrypted))
	foreign, err := resolveForRun(svc, context.Background(), 8, 2, "claude")
	require.NoError(t, err)
	assert.Nil(t, foreign, "a collaborator cannot resolve the owner's connection")
	other, err := svc.ConnectForUser(context.Background(), bob, ConnectProviderInput{Provider: "claude", Label: "web-request-1", AccessToken: "sk-ant-api03-bob"})
	require.NoError(t, err)
	assert.NotEqual(t, first.ID, other.ID)
	assert.Equal(t, 2, len(q.rows))
}

// A subscription serves only its account holder's own runs, so nobody can
// connect one for an organization, and a legacy organization row never
// resolves for a member's run.
func TestProviderConnection_OrganizationConnectionsNeverServeRuns(t *testing.T) {
	q := newFakePCQ()
	q.repos[1] = db.Repository{ID: 1, OrgID: pgtype.Int8{Int64: 3, Valid: true}}
	q.orgs["acme"] = db.Organization{ID: 3, Name: "acme", LowerName: "acme"}
	q.members[[2]int64{3, 7}] = "member"
	q.members[[2]int64{3, 8}] = "owner"
	svc := newPCService(q, nil)
	_, err := svc.ConnectForOrg(context.Background(), &db.User{ID: 8}, "acme", ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-api03-x"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "own runs")
	assert.Empty(t, q.rows)

	_, err = q.CreateProviderConnection(context.Background(), db.CreateProviderConnectionParams{OwnerType: "org", OrgID: pgtype.Int8{Int64: 3, Valid: true}, Provider: "claude", Kind: "api_key", AccessTokenEncrypted: []byte("enc:sk-ant-api03-org")})
	require.NoError(t, err)
	for _, preference := range []string{ProviderConnectionPreferenceOrgFirst, ProviderConnectionPreferenceOrgOnly, ProviderConnectionPreferenceUserFirst} {
		require.NoError(t, svc.SetRepositoryPreference(context.Background(), 1, preference))
		resolved, err := resolveForRun(svc, context.Background(), 7, 1, "claude")
		require.NoError(t, err)
		assert.Nil(t, resolved, preference)
	}
	// A member may still list legacy rows so an owner can revoke them.
	_, err = svc.ListForOrg(context.Background(), &db.User{ID: 7}, "acme")
	require.NoError(t, err)
	_, err = svc.ListForOrg(context.Background(), &db.User{ID: 9}, "acme")
	require.Error(t, err)
}

func TestProviderConnection_ResolveOnlyTheRunUsersOwnConnection(t *testing.T) {
	q := newFakePCQ()
	q.repos[1] = db.Repository{ID: 1, OrgID: pgtype.Int8{Int64: 3, Valid: true}}
	q.repos[2] = db.Repository{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	svc := newPCService(q, nil)
	user := &db.User{ID: 7}
	userConn, err := svc.ConnectForUser(context.Background(), user, ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-api03-user"})
	require.NoError(t, err)

	// Org repo without a grant: nothing.
	resolved, err := resolveForRun(svc, context.Background(), 7, 1, "smithers")
	require.NoError(t, err)
	assert.Nil(t, resolved)

	// With an org grant the user's own run on the org repo uses it.
	_, err = svc.AddGrant(context.Background(), user, userConn.ID, ProviderConnectionGrantInput{OrgID: ptrInt64(3)})
	require.NoError(t, err)
	resolved, err = resolveForRun(svc, context.Background(), 7, 1, "smithers")
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Equal(t, userConn.ID, resolved.ConnectionID)
	assert.Equal(t, "sk-ant-api03-user", resolved.AccessToken)

	// Another user's run on the same repo never gets it.
	resolved, err = resolveForRun(svc, context.Background(), 9, 1, "smithers")
	require.NoError(t, err)
	assert.Nil(t, resolved)

	// The user's own repo needs no grant.
	resolved, err = resolveForRun(svc, context.Background(), 7, 2, "smithers")
	require.NoError(t, err)
	assert.Equal(t, userConn.ID, resolved.ConnectionID)

	// platform_only never resolves; a codex run finds no codex connection.
	require.NoError(t, svc.SetRepositoryPreference(context.Background(), 2, ProviderConnectionPreferencePlatformOnly))
	resolved, err = resolveForRun(svc, context.Background(), 7, 2, "smithers")
	require.NoError(t, err)
	assert.Nil(t, resolved)
	resolved, err = resolveForRun(svc, context.Background(), 7, 1, "codex")
	require.NoError(t, err)
	assert.Nil(t, resolved)

	// A revoked connection is skipped.
	require.NoError(t, svc.SetRepositoryPreference(context.Background(), 2, ProviderConnectionPreferenceUserFirst))
	require.NoError(t, svc.Revoke(context.Background(), user, userConn.ID))
	resolved, err = resolveForRun(svc, context.Background(), 7, 2, "smithers")
	require.NoError(t, err)
	assert.Nil(t, resolved)
}

// With the deployment flag off (the hosted default) a stored connection is
// inert: no run resolves it, the worker never refreshes it, and the service
// refuses new ones even if a route gate were missing.
func TestProviderConnection_DisabledDeploymentResolvesNothing(t *testing.T) {
	q := newFakePCQ()
	q.repos[2] = db.Repository{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	soon := time.Now().Add(time.Minute)
	_, err := newPCService(q, nil).ConnectForUser(context.Background(), &db.User{ID: 7}, ConnectProviderInput{Provider: "codex", AccessToken: "at-user", RefreshToken: "r", AccountID: "acct", AccessExpiresAt: &soon})
	require.NoError(t, err)

	refresher := &stubRefresher{tokens: RefreshedTokens{AccessToken: "fresh", ExpiresAt: time.Now().Add(time.Hour)}}
	for name, svc := range map[string]*ProviderConnectionService{
		"default":  NewProviderConnectionService(q, plainCodec{}, refresher),
		"explicit": NewProviderConnectionService(q, plainCodec{}, refresher, WithSubscriptionConnectionsEnabled(false)),
	} {
		t.Run(name, func(t *testing.T) {
			resolved, err := resolveForRun(svc, context.Background(), 7, 2, "codex")
			require.NoError(t, err)
			assert.Nil(t, resolved)

			did, err := svc.RefreshDue(context.Background())
			require.NoError(t, err)
			assert.False(t, did)
			assert.Zero(t, refresher.calls)

			_, err = svc.ConnectForUser(context.Background(), &db.User{ID: 7}, ConnectProviderInput{Provider: "codex", AccessToken: "at", RefreshToken: "rt", AccountID: "acct"})
			require.Error(t, err)
			assert.Contains(t, err.Error(), "not available")
		})
	}
}

// The refresh worker is not started when the flag is off.
func TestProviderConnectionRefreshWorker_DisabledReturnsImmediately(t *testing.T) {
	q := newFakePCQ()
	worker := NewProviderConnectionRefreshWorker(NewProviderConnectionService(q, plainCodec{}, nil), time.Hour, nil)
	done := make(chan struct{})
	go func() {
		worker.Start(context.Background())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("refresh worker kept running with subscription connections disabled")
	}
}

func TestProviderConnection_RevocationDuringResolutionFailsClosed(t *testing.T) {
	q := newFakePCQ()
	q.repos[2] = db.Repository{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	owner := &db.User{ID: 7}
	svc := newPCService(q, nil)
	connection, err := svc.ConnectForUser(context.Background(), owner, ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-api03-fixture"})
	require.NoError(t, err)
	decrypted := false
	svc.codec = revokingCodec{revoke: func() {
		if decrypted {
			return
		}
		decrypted = true
		require.NoError(t, svc.Revoke(context.Background(), owner, connection.ID))
	}}
	resolved, err := resolveForRun(svc, context.Background(), 7, 2, "claude")
	require.NoError(t, err)
	assert.Nil(t, resolved)
	assert.True(t, decrypted)
	assert.Equal(t, "revoked", q.rows[connection.ID].State)
	require.NoError(t, q.UpdateProviderConnectionTokens(context.Background(), db.UpdateProviderConnectionTokensParams{ID: connection.ID, AccessTokenEncrypted: []byte("enc:new-token")}))
	assert.Equal(t, "revoked", q.rows[connection.ID].State, "a late refresh must not reactivate a revoked connection")
}

func TestProviderConnection_RefreshLoopStates(t *testing.T) {
	q := newFakePCQ()
	refresher := &stubRefresher{tokens: RefreshedTokens{AccessToken: "acc2", RefreshToken: "ref2", ExpiresAt: time.Now().Add(2 * time.Hour)}}
	svc := newPCService(q, refresher)
	user := &db.User{ID: 7}
	soon := time.Now().Add(10 * time.Minute)
	conn, err := svc.ConnectForUser(context.Background(), user, ConnectProviderInput{Provider: "codex", AccessToken: "acc1", RefreshToken: "ref1", AccountID: "acct", AccessExpiresAt: &soon})
	require.NoError(t, err)

	did, err := svc.RefreshDue(context.Background())
	require.NoError(t, err)
	assert.True(t, did)
	assert.Equal(t, 1, refresher.calls)
	row := q.rows[conn.ID]
	assert.Equal(t, "enc:acc2", string(row.AccessTokenEncrypted))
	assert.Equal(t, "enc:ref2", string(row.RefreshTokenEncrypted), "a rotated refresh token replaces the old one")
	assert.True(t, row.NextRefreshAt.Time.After(time.Now()))

	// Nothing due now.
	did, err = svc.RefreshDue(context.Background())
	require.NoError(t, err)
	assert.False(t, did)

	// Transient failures back off and eventually mark refresh_failed.
	row.AccessExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true}
	row.NextRefreshAt = pgtype.Timestamptz{}
	q.rows[conn.ID] = row
	refresher.err = errors.New("503 from provider")
	for i := 0; i < providerConnectionMaxFailures; i++ {
		r := q.rows[conn.ID]
		r.NextRefreshAt = pgtype.Timestamptz{}
		q.rows[conn.ID] = r
		_, _ = svc.RefreshDue(context.Background())
	}
	assert.Equal(t, ProviderConnectionStateRefreshFailed, q.rows[conn.ID].State)
	assert.Contains(t, q.rows[conn.ID].LastError, "503")

	// invalid_grant means the token was revoked or reused elsewhere.
	conn2, err := svc.ConnectForUser(context.Background(), user, ConnectProviderInput{Provider: "codex", AccessToken: "a", RefreshToken: "r", AccountID: "acct", AccessExpiresAt: &soon})
	require.NoError(t, err)
	refresher.err = ErrProviderRefreshInvalidGrant
	_, _ = svc.RefreshDue(context.Background())
	assert.Equal(t, ProviderConnectionStateRevoked, q.rows[conn2.ID].State)
}

func TestProviderConnection_DispatchRefreshesExpiringTokenSynchronously(t *testing.T) {
	q := newFakePCQ()
	q.repos[2] = db.Repository{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	refresher := &stubRefresher{tokens: RefreshedTokens{AccessToken: "fresh", ExpiresAt: time.Now().Add(time.Hour)}}
	svc := newPCService(q, refresher)
	soon := time.Now().Add(time.Minute)
	_, err := svc.ConnectForUser(context.Background(), &db.User{ID: 7}, ConnectProviderInput{Provider: "codex", AccessToken: "stale", RefreshToken: "r", AccountID: "acct", AccessExpiresAt: &soon})
	require.NoError(t, err)
	resolved, err := resolveForRun(svc, context.Background(), 7, 2, "codex")
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Equal(t, "fresh", resolved.AccessToken)
	assert.Equal(t, 1, refresher.calls)
}

// Only a Codex sign-in refreshes: there is no Claude refresh client (#2777).
func TestHTTPProviderTokenRefresher_CodexOnly(t *testing.T) {
	var seen []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		seen = append(seen, body)
		switch r.URL.Path {
		case "/codex":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "codex-new", "refresh_token": "codex-ref-new", "id_token": testIDToken(t, "acct_9", "pro", "p@example.com")})
		case "/revoked":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
		}
	}))
	defer server.Close()
	r := NewHTTPProviderTokenRefresher(ProviderConnectionsConfig{CodexTokenURL: server.URL + "/codex", CodexClientID: "cid-codex"}, server.Client())

	_, err := r.Refresh(context.Background(), "claude", "sk-ant-ort01-old")
	require.Error(t, err)
	assert.Empty(t, seen, "a Claude refresh token is never sent anywhere")

	codex, err := r.Refresh(context.Background(), "codex", "codex-ref-old")
	require.NoError(t, err)
	assert.Equal(t, "acct_9", codex.AccountID)
	assert.Equal(t, "pro", codex.Plan)
	assert.Equal(t, "p@example.com", codex.AccountEmail)
	assert.Equal(t, "cid-codex", seen[0]["client_id"])
	assert.Equal(t, "refresh_token", seen[0]["grant_type"])
	assert.Equal(t, "openid profile email", seen[0]["scope"])

	r2 := NewHTTPProviderTokenRefresher(ProviderConnectionsConfig{CodexTokenURL: server.URL + "/revoked"}, server.Client())
	_, err = r2.Refresh(context.Background(), "codex", "dead")
	assert.ErrorIs(t, err, ErrProviderRefreshInvalidGrant)
}

func testIDToken(t *testing.T, accountID, plan, email string) string {
	t.Helper()
	claims, _ := json.Marshal(map[string]any{"email": email, "https://api.openai.com/auth": map[string]any{"chatgpt_account_id": accountID, "chatgpt_plan_type": plan}})
	return "eyJhbGciOiJSUzI1NiJ9." + base64URL(claims) + ".sig"
}

func base64URL(b []byte) string {
	const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	var out strings.Builder
	for i := 0; i < len(b); i += 3 {
		var chunk [3]byte
		n := copy(chunk[:], b[i:])
		v := uint32(chunk[0])<<16 | uint32(chunk[1])<<8 | uint32(chunk[2])
		out.WriteByte(table[v>>18&63])
		out.WriteByte(table[v>>12&63])
		if n > 1 {
			out.WriteByte(table[v>>6&63])
		}
		if n > 2 {
			out.WriteByte(table[v&63])
		}
	}
	return out.String()
}

func TestProviderConnection_ManualRefreshRecoversFailedConnection(t *testing.T) {
	q := newFakePCQ()
	refresher := &stubRefresher{tokens: RefreshedTokens{AccessToken: "fresh", RefreshToken: "rotated", ExpiresAt: time.Now().Add(time.Hour)}}
	svc := newPCService(q, refresher)
	actor := &db.User{ID: 7}
	connection, err := svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "codex", AccessToken: "old", RefreshToken: "refresh", AccountID: "acct"})
	require.NoError(t, err)
	row := q.rows[connection.ID]
	row.State, row.RefreshFailures, row.LastError = ProviderConnectionStateRefreshFailed, 5, "temporary provider failure"
	q.rows[connection.ID] = row
	updated, err := svc.RefreshNow(context.Background(), actor, connection.ID)
	require.NoError(t, err)
	assert.Equal(t, ProviderConnectionStateActive, updated.State)
	assert.Equal(t, "enc:fresh", string(q.rows[connection.ID].AccessTokenEncrypted))
	assert.Zero(t, q.rows[connection.ID].RefreshFailures)
}

// resolveForRun picks the account the pool would serve a run's next model
// call with, or nil when the run keeps the platform credentials.
func resolveForRun(svc *ProviderConnectionService, ctx context.Context, userID, repositoryID int64, provider string) (*ResolvedProviderConnection, error) {
	pick, err := svc.PickForModelCall(ctx, userID, repositoryID, provider, nil)
	return pick.Connection, err
}
