package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type failedSetupWriter struct{}

func (failedSetupWriter) Write([]byte) (int, error) { return 0, errors.New("closed stdout") }

func TestSetupEmissionRotationAndWriteFailure(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	require.NoError(t, q.PutInstallSetting(ctx, db.PutInstallSettingParams{Key: InstallPublicOriginsKey, Value: []byte(`["http://lan-a:4000","https://box.example"]`)}))
	var out bytes.Buffer
	require.NoError(t, EmitSetupURLs(ctx, pool, &out))
	// spec §5.1.0 and T-ACC-07: sole key, fixed loopback and stored origins.
	var line map[string][]string
	require.NoError(t, json.Unmarshal(out.Bytes(), &line))
	require.Len(t, line, 1)
	require.Len(t, line["setup_urls"], 3)
	token := line["setup_urls"][0][len("http://localhost:4000/setup?token="):]
	require.NotEmpty(t, token)
	require.Equal(t, []string{"http://localhost:4000/setup?token=" + token, "http://lan-a:4000/setup?token=" + token, "https://box.example/setup?token=" + token}, line["setup_urls"])
	require.Equal(t, byte('\n'), out.Bytes()[out.Len()-1])
	sum := sha256.Sum256([]byte(token))
	stored, err := q.GetInstallSetting(ctx, setupTokenKey)
	require.NoError(t, err)
	require.JSONEq(t, `{"digest":"`+hex.EncodeToString(sum[:])+`"}`, string(stored))
	require.NotContains(t, string(stored), token)
	require.ErrorContains(t, EmitSetupURLs(ctx, pool, failedSetupWriter{}), "closed stdout")
	afterFailure, err := q.GetInstallSetting(ctx, setupTokenKey)
	require.NoError(t, err)
	require.NotEqual(t, string(stored), string(afterFailure))
	out.Reset()
	require.NoError(t, EmitSetupURLs(ctx, pool, &out))
	require.NotContains(t, out.String(), token)
	next, err := q.GetInstallSetting(ctx, setupTokenKey)
	require.NoError(t, err)
	require.NotEqual(t, string(afterFailure), string(next))
}

func TestSetupEmissionCommitFailurePrintsNothing(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `CREATE FUNCTION reject_setup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'digest commit rejected'; END $$;
 CREATE CONSTRAINT TRIGGER reject_setup AFTER INSERT OR UPDATE ON install_settings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_setup();`)
	require.NoError(t, err)
	var out bytes.Buffer
	require.ErrorContains(t, EmitSetupURLs(ctx, pool, &out), "digest commit rejected")
	require.Empty(t, out.String())
	var count int
	require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM install_settings WHERE key='setup_token'").Scan(&count))
	require.Zero(t, count)
}

func TestSetupTokenDigestIgnoresSurroundingSpace(t *testing.T) {
	require.Equal(t, SetupTokenDigest("abc"), SetupTokenDigest(" abc\n"))
	require.Len(t, SetupTokenDigest("abc"), 64)
}

// This reader represents the pre-repository setup state, not fake PostgreSQL.
type setupNoRepository struct{}

func (setupNoRepository) InstallRepository(context.Context) (InstallRepository, bool, error) {
	return InstallRepository{}, false, nil
}

type blockedSetupWriter struct {
	started chan string
	release chan struct{}
}

func (w blockedSetupWriter) Write(p []byte) (int, error) {
	w.started <- string(p)
	<-w.release
	return len(p), nil
}

func TestSetupMintBeforeClaimSerializesEmission(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	writer := blockedSetupWriter{make(chan string, 1), make(chan struct{})}
	emitted := make(chan error, 1)
	go func() { emitted <- EmitSetupURLs(ctx, pool, writer) }()
	var line string
	select {
	case line = <-writer.started:
	case <-time.After(10 * time.Second):
		t.Fatal("mint did not reach emission")
	}
	defer func() {
		select {
		case <-writer.release:
		default:
			close(writer.release)
		}
	}()
	var parsed struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal([]byte(line), &parsed))
	token := strings.TrimPrefix(parsed.URLs[0], "http://localhost:4000/setup?token=")
	claim := make(chan error, 1)
	go func() {
		_, err := NewMemberService(pool, setupNoRepository{}).claimOwner(ctx, GitHubSignIn{GitHubUserID: 7007, Login: "owner", SetupTokenDigest: SetupTokenDigest(token)})
		claim <- err
	}()
	require.Eventually(t, func() bool {
		var n int
		err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())").Scan(&n)
		return err == nil && n > 0
	}, 10*time.Second, 10*time.Millisecond)
	select {
	case <-claim:
		t.Fatal("claim crossed unfinished emission")
	default:
	}
	close(writer.release)
	require.NoError(t, <-emitted)
	require.NoError(t, <-claim)
	var out bytes.Buffer
	require.NoError(t, EmitSetupURLs(ctx, pool, &out))
	require.Empty(t, out.String())
}

func TestSetupClaimBeforeMintPreventsEmission(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	token, err := MintSetupToken(ctx, pool)
	require.NoError(t, err)
	// Pause the real claim after it holds the shared lock, inside owner insert.
	barrier, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer barrier.Release()
	_, err = barrier.Exec(ctx, "SELECT pg_advisory_lock(7007007)")
	require.NoError(t, err)
	defer barrier.Exec(ctx, "SELECT pg_advisory_unlock(7007007)")
	_, err = pool.Exec(ctx, `CREATE FUNCTION pause_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(7007007); RETURN NEW; END $$; CREATE TRIGGER pause_owner BEFORE INSERT ON members FOR EACH ROW EXECUTE FUNCTION pause_owner();`)
	require.NoError(t, err)
	claim := make(chan error, 1)
	go func() {
		_, e := NewMemberService(pool, setupNoRepository{}).claimOwner(ctx, GitHubSignIn{GitHubUserID: 7007, Login: "owner", SetupTokenDigest: SetupTokenDigest(token)})
		claim <- e
	}()
	require.Eventually(t, func() bool {
		var n int
		err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=7007007").Scan(&n)
		return err == nil && n > 0
	}, 10*time.Second, 10*time.Millisecond)
	var out bytes.Buffer
	mint := make(chan error, 1)
	go func() { mint <- EmitSetupURLs(ctx, pool, &out) }()
	require.Eventually(t, func() bool {
		var n int
		err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())").Scan(&n)
		return err == nil && n >= 2
	}, 10*time.Second, 10*time.Millisecond)
	_, err = barrier.Exec(ctx, "SELECT pg_advisory_unlock(7007007)")
	require.NoError(t, err)
	require.NoError(t, <-claim)
	require.NoError(t, <-mint)
	require.Empty(t, out.String())
}

func TestSetupTokenMatchesRejectsMalformedAndEmptyDigests(t *testing.T) {
	sum := sha256.Sum256([]byte("fixture-token"))
	digest := hex.EncodeToString(sum[:])
	stored := []byte(`{"digest":"` + digest + `"}`)
	require.True(t, setupTokenMatches(stored, digest))
	require.False(t, setupTokenMatches(stored, SetupTokenDigest("other")))
	for _, value := range [][]byte{nil, []byte(`{`), []byte(`{}`), []byte(`{"digest":""}`)} {
		require.False(t, setupTokenMatches(value, digest))
	}
	require.False(t, setupTokenMatches(stored, ""))
}

func TestSetupInvalidStoredOriginsEmitsNothing(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	require.NoError(t, db.New(pool).PutInstallSetting(ctx, db.PutInstallSettingParams{Key: InstallPublicOriginsKey, Value: []byte(`{"origin":"https://box.example"}`)}))
	var out bytes.Buffer
	require.ErrorContains(t, EmitSetupURLs(ctx, pool, &out), "read public origins")
	require.Empty(t, out.String())
}

type shortSetupWriter struct{}

func (shortSetupWriter) Write([]byte) (int, error) { return 0, nil }
func TestSetupShortStdoutWriteIsFailure(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	require.ErrorIs(t, EmitSetupURLs(context.Background(), pool, shortSetupWriter{}), io.ErrShortWrite)
}

func TestSetupCancelledLockDoesNotLeakSessionLock(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	blocker, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer blocker.Release()
	_, err = blocker.Exec(ctx, "SELECT pg_advisory_lock($1)", installSetupOwnerLockID)
	require.NoError(t, err)
	defer blocker.Exec(ctx, "SELECT pg_advisory_unlock($1)", installSetupOwnerLockID)
	cancelCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	var out bytes.Buffer
	require.Error(t, EmitSetupURLs(cancelCtx, pool, &out))
	require.Empty(t, out.String())
	_, err = blocker.Exec(ctx, "SELECT pg_advisory_unlock($1)", installSetupOwnerLockID)
	require.NoError(t, err)
	retryCtx, stop := context.WithTimeout(ctx, 5*time.Second)
	defer stop()
	require.NoError(t, EmitSetupURLs(retryCtx, pool, &out))
	require.NotEmpty(t, out.String())
}
