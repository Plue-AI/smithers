package services

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallAPIIssuesOnlyForClaimedAuthorsAndRevokes(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	svc := NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"owner","repository_name":"repo","repository_id":1}`)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(`{"owner_login":"owner","repository_name":"repo","repository_id":1,"last_access_check_at":"2026-10-06T15:00:00Z"}`)}))
	svc.Members = &Members{Pool: pool}
	api := InstallAPI{Auth: svc}
	create := func(shared bool) string {
		id := uuid.NewString()
		_, err := pool.Exec(ctx, `INSERT INTO chat_turns(id,user_id,run_id,leg_id,request_hash,access_hash,request_payload,state,producer_generation,producer_token_hash,producer_lease_expires_at)
   VALUES($1,$2,$1,'leg','hash','access',$3,'running',1,'producer',NOW()+interval '1 hour')`, id, owner.ID, fmt.Sprintf(`{"sharedConversation":%t}`, shared))
		require.NoError(t, err)
		return id
	}
	shared := create(true)
	token, err := api.Begin(ctx, middleware.Credential{}, owner.ID, shared, 1)
	require.NoError(t, err)
	require.Equal(t, "owner", token.Author)
	sum := sha256.Sum256([]byte(token.Token))
	held := middleware.Credential{TokenHash: hex.EncodeToString(sum[:])}
	info, err := middleware.ReloadCredential(ctx, q, held, time.Now())
	require.NoError(t, err)
	require.Equal(t, "smithers", info.ActingVia())
	require.True(t, info.ReadsRepositoriesForTurn())
	require.NoError(t, api.End(ctx, owner.ID, token.TokenID))
	_, err = middleware.ReloadCredential(ctx, q, held, time.Now())
	require.ErrorIs(t, err, middleware.ErrCredentialGone)
	legacy := create(false)
	_, err = api.Begin(ctx, middleware.Credential{}, owner.ID, legacy, 1)
	require.ErrorIs(t, err, ErrAPIForbidden)
	session := turnSession(t, pool, owner, time.Now().Add(time.Hour))
	token, err = api.Begin(ctx, session, owner.ID, legacy, 1)
	require.NoError(t, err)
	require.NoError(t, api.End(ctx, owner.ID, token.TokenID))
	for _, subject := range []struct {
		id         string
		generation int64
	}{{shared, 2}, {"missing", 1}} {
		_, err = api.Begin(ctx, session, owner.ID, subject.id, subject.generation)
		require.ErrorIs(t, err, ErrAPIForbidden)
	}
	_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = api.Begin(ctx, session, owner.ID, shared, 1)
	require.Error(t, err)
}

// A delegated producer can use the existing source service, including after
// restart without the admitting browser cookie. Replacing its claim fences
// subsequent reads even while the token row still exists.
func TestInstallAPIBearerReadsSourceOnlyWhileItsProducerIsLive(t *testing.T) {
	f := newMirrorReadFixture(t)
	f.ready()
	ctx := t.Context()
	q := db.New(f.pool)
	svc := NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
	svc.Members = &Members{Pool: f.pool}
	api := InstallAPI{Auth: svc}
	id := uuid.NewString()
	_, err := f.pool.Exec(ctx, `INSERT INTO chat_turns(id,user_id,run_id,leg_id,request_hash,access_hash,request_payload,state,producer_generation,producer_token_hash,producer_lease_expires_at)
	 VALUES($1,$2,$1,'leg','hash','access','{"sharedConversation":true}','running',1,'producer',NOW()+interval '1 hour')`, id, f.owner.ID)
	require.NoError(t, err)
	token, err := api.Begin(ctx, middleware.Credential{}, f.owner.ID, id, 1)
	require.NoError(t, err)
	defer func() { require.NoError(t, api.End(ctx, f.owner.ID, token.TokenID)) }()
	sum := sha256.Sum256([]byte(token.Token))
	credential := middleware.Credential{TokenHash: hex.EncodeToString(sum[:])}
	file, err := f.reader.ReadSource(ctx, credential, f.owner.ID, f.mirror, "JOURNEY.md")
	require.NoError(t, err)
	require.Equal(t, mirrorReadJourney, file.Content)
	_, err = f.reader.ReadSource(ctx, credential, f.member.ID, f.mirror, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceForbidden)
	_, err = f.pool.Exec(ctx, `UPDATE chat_turns SET producer_generation=2 WHERE id=$1`, id)
	require.NoError(t, err)
	_, err = f.reader.ReadSource(ctx, credential, f.owner.ID, f.mirror, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceForbidden)
}
