package flowhost

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

var journalTestKey = []byte(strings.Repeat("k", 32))

func TestJournalDatabaseNameIsTheCanonicalWorkspace(t *testing.T) {
	workspace := "0f1e2d3c-4b5a-4968-8776-655443322110"
	name, err := JournalDatabaseName(workspace)
	require.NoError(t, err)
	assert.Equal(t, "smithers_flows_0f1e2d3c4b5a49688776655443322110", name)
	assert.LessOrEqual(t, len(name), 63, "a PostgreSQL identifier")
	for _, invalid := range []string{"", "workspace-1", strings.ToUpper(workspace), "{" + workspace + "}", strings.ReplaceAll(workspace, "-", "")} {
		_, err = JournalDatabaseName(invalid)
		require.Error(t, err, invalid)
	}
}

func TestPostgresJournalsDescribeMintsTheSameCredentialEverywhere(t *testing.T) {
	journals := &PostgresJournals{address: mustURL(t, "postgres://journal.internal:5432/?sslmode=require"), key: journalTestKey}
	workspace := uuid.NewString()
	first, err := journals.Describe(workspace)
	require.NoError(t, err)
	again, err := (&PostgresJournals{address: journals.address, key: journalTestKey}).Describe(workspace)
	require.NoError(t, err)
	assert.Equal(t, first, again, "every replica and restart derives the same credential")
	parsed := mustURL(t, first.URL)
	password, _ := parsed.User.Password()
	assert.Len(t, password, 64)
	assert.Equal(t, first.Name, parsed.User.Username())
	assert.Equal(t, "/"+first.Name, parsed.Path)
	assert.Equal(t, "journal.internal:5432", parsed.Host)
	assert.Equal(t, "require", parsed.Query().Get("sslmode"))
	assert.Equal(t, JournalSchema, first.Schema)
	other, err := journals.Describe(uuid.NewString())
	require.NoError(t, err)
	otherPassword, _ := mustURL(t, other.URL).User.Password()
	assert.NotEqual(t, password, otherPassword)
	rotated, err := (&PostgresJournals{address: journals.address, key: []byte(strings.Repeat("r", 32))}).Describe(workspace)
	require.NoError(t, err)
	assert.NotEqual(t, first.URL, rotated.URL)
	_, err = journals.Describe("workspace-1")
	require.Error(t, err)
}

func TestNewPostgresJournalsRefusesAnUnusableConfiguration(t *testing.T) {
	ctx := context.Background()
	_, err := NewPostgresJournals(ctx, nil, "postgres://db", journalTestKey)
	require.Error(t, err)
	pool := &pgxpool.Pool{}
	_, err = NewPostgresJournals(ctx, pool, "postgres://db", journalTestKey[:31])
	require.Error(t, err)
	for _, address := range []string{"", "mysql://db", "postgres:///journal", "::"} {
		_, err = NewPostgresJournals(ctx, pool, address, journalTestKey)
		require.Error(t, err, address)
	}
}

func TestScramVerifierIsPostgresStoredForm(t *testing.T) {
	first, err := scramVerifier("secret")
	require.NoError(t, err)
	second, err := scramVerifier("secret")
	require.NoError(t, err)
	assert.Regexp(t, `^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$`, first)
	assert.NotEqual(t, first, second, "a fresh salt each time")
	assert.NotContains(t, first, "secret")
}

// journalServer is an administrator role with CREATEROLE and CREATEDB (not
// superuser) that owns a fresh backend database, as a self-hosted backend is.
type journalServer struct {
	superuser    *pgx.Conn
	superuserURL string
	adminURL     string
	pool         *pgxpool.Pool
	backend      string
	names        []string
	mu           sync.Mutex
}

func newJournalServer(t *testing.T, ownsBackend bool) *journalServer {
	t.Helper()
	database := testdb.New(t)
	ctx := context.Background()
	superuser, err := pgx.Connect(ctx, database.URL)
	require.NoError(t, err)
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	admin := "smithers_test_journal_admin_" + hex.EncodeToString(suffix)
	password := hex.EncodeToString(suffix) + "pw"
	_, err = superuser.Exec(ctx, "CREATE ROLE "+admin+" LOGIN CREATEROLE CREATEDB PASSWORD '"+password+"'")
	require.NoError(t, err)
	server := &journalServer{superuser: superuser, superuserURL: database.URL, backend: database.Name}
	t.Cleanup(func() {
		ctx := context.Background()
		server.pool.Close()
		for _, name := range server.names {
			_, _ = superuser.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
			_, _ = superuser.Exec(ctx, "DROP ROLE IF EXISTS "+name)
		}
		_, _ = superuser.Exec(ctx, "ALTER DATABASE "+pgx.Identifier{database.Name}.Sanitize()+" OWNER TO CURRENT_USER")
		_, _ = superuser.Exec(ctx, "DROP ROLE IF EXISTS "+admin)
		_ = superuser.Close(ctx)
	})
	if ownsBackend {
		_, err = superuser.Exec(ctx, "ALTER DATABASE "+pgx.Identifier{database.Name}.Sanitize()+" OWNER TO "+admin)
		require.NoError(t, err)
	}
	adminURL := mustURL(t, database.URL)
	adminURL.User = url.UserPassword(admin, password)
	server.adminURL = adminURL.String()
	server.pool, err = pgxpool.New(ctx, server.adminURL)
	require.NoError(t, err)
	return server
}

func (server *journalServer) provisioned(t *testing.T, journals *PostgresJournals, workspace string) JournalDatabase {
	t.Helper()
	name, err := JournalDatabaseName(workspace)
	require.NoError(t, err)
	server.mu.Lock()
	server.names = append(server.names, name)
	server.mu.Unlock()
	journal, err := journals.Provision(context.Background(), workspace)
	require.NoError(t, err)
	return journal
}

func TestPostgresJournalsGiveEachWorkspaceOnlyItsOwnDatabase(t *testing.T) {
	server := newJournalServer(t, true)
	ctx := context.Background()
	journals, err := NewPostgresJournals(ctx, server.pool, server.adminURL, journalTestKey)
	require.NoError(t, err)
	workspace := uuid.NewString()
	journal := server.provisioned(t, journals, workspace)
	described, err := journals.Describe(workspace)
	require.NoError(t, err)
	assert.Equal(t, described, journal)

	// The workspace role opens its own database and creates the stores the
	// host's adapter creates: one schema per store under the journal prefix.
	own, err := pgx.Connect(ctx, journal.URL)
	require.NoError(t, err)
	defer own.Close(ctx)
	_, err = own.Exec(ctx, "CREATE SCHEMA IF NOT EXISTS flows_control_db; CREATE TABLE flows_control_db.events(id bigint PRIMARY KEY)")
	require.NoError(t, err)
	var super, createRole, createDB bool
	require.NoError(t, own.QueryRow(ctx, `SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`).Scan(&super, &createRole, &createDB))
	assert.False(t, super || createRole || createDB)

	// It never reaches the backend's database (and so never its tables).
	backend := mustURL(t, journal.URL)
	backend.Path = "/" + server.backend
	_, err = pgx.Connect(ctx, backend.String())
	require.ErrorContains(t, err, "permission denied")

	// Nor another workspace's journals, with its own credential or with
	// another workspace's database name.
	other := server.provisioned(t, journals, uuid.NewString())
	crossed := mustURL(t, journal.URL)
	crossed.Path = "/" + other.Name
	_, err = pgx.Connect(ctx, crossed.String())
	require.ErrorContains(t, err, "permission denied")
	wrongPassword := mustURL(t, other.URL)
	ownPassword, _ := backend.User.Password()
	wrongPassword.User = url.UserPassword(other.Name, ownPassword)
	_, err = pgx.Connect(ctx, wrongPassword.String())
	require.ErrorContains(t, err, "password authentication failed")

	// The server stores a verifier, never the password.
	var stored string
	require.NoError(t, server.superuser.QueryRow(ctx, `SELECT rolpassword FROM pg_authid WHERE rolname = $1`, journal.Name).Scan(&stored))
	password, _ := mustURL(t, journal.URL).User.Password()
	assert.True(t, strings.HasPrefix(stored, "SCRAM-SHA-256$"))
	assert.NotContains(t, stored, password)
}

func TestPostgresJournalsProvisionIsIdempotentAcrossConcurrentStarts(t *testing.T) {
	server := newJournalServer(t, true)
	ctx := context.Background()
	journals, err := NewPostgresJournals(ctx, server.pool, server.adminURL, journalTestKey)
	require.NoError(t, err)
	workspace := uuid.NewString()
	first := server.provisioned(t, journals, workspace)
	live, err := pgx.Connect(ctx, first.URL)
	require.NoError(t, err)
	defer live.Close(ctx)
	_, err = live.Exec(ctx, "CREATE SCHEMA flows_engine_db; CREATE TABLE flows_engine_db.kept(id int); INSERT INTO flows_engine_db.kept VALUES (7)")
	require.NoError(t, err)

	// A second backend replica (its own pool) and repeated starts race.
	replicaPool, err := pgxpool.New(ctx, server.adminURL)
	require.NoError(t, err)
	defer replicaPool.Close()
	replica, err := NewPostgresJournals(ctx, replicaPool, server.adminURL, journalTestKey)
	require.NoError(t, err)
	var wait sync.WaitGroup
	results := make([]JournalDatabase, 8)
	failures := make([]error, 8)
	for index := range results {
		wait.Go(func() {
			provisioner := journals
			if index%2 == 1 {
				provisioner = replica
			}
			results[index], failures[index] = provisioner.Provision(ctx, workspace)
		})
	}
	wait.Wait()
	for index := range results {
		require.NoError(t, failures[index])
		assert.Equal(t, first, results[index])
	}
	// The live host's connection and the journal it wrote survive every start,
	// and a new connection with the same credential still authenticates.
	var kept int
	require.NoError(t, live.QueryRow(ctx, "SELECT id FROM flows_engine_db.kept").Scan(&kept))
	assert.Equal(t, 7, kept)
	reconnect, err := pgx.Connect(ctx, first.URL)
	require.NoError(t, err)
	require.NoError(t, reconnect.QueryRow(ctx, "SELECT id FROM flows_engine_db.kept").Scan(&kept))
	_ = reconnect.Close(ctx)

	// A role that already exists (a database dropped by an operator) is
	// repaired and gets its database back.
	_, err = server.superuser.Exec(ctx, "DROP DATABASE "+first.Name+" WITH (FORCE)")
	require.NoError(t, err)
	_, err = server.superuser.Exec(ctx, "ALTER ROLE "+first.Name+" CREATEDB PASSWORD NULL")
	require.NoError(t, err)
	repaired, err := journals.Provision(ctx, workspace)
	require.NoError(t, err)
	assert.Equal(t, first, repaired)
	var createDB bool
	require.NoError(t, server.superuser.QueryRow(ctx, `SELECT rolcreatedb FROM pg_roles WHERE rolname = $1`, first.Name).Scan(&createDB))
	assert.False(t, createDB)
	fresh, err := pgx.Connect(ctx, repaired.URL)
	require.NoError(t, err)
	_ = fresh.Close(ctx)

	// A server privilege only a superuser could have given the role is never
	// handed to a host: a CREATEROLE backend cannot alter such a role, and a
	// superuser backend (the local embedded server) refuses it.
	superuserPool, err := pgxpool.New(ctx, server.superuserURL)
	require.NoError(t, err)
	defer superuserPool.Close()
	asSuperuser, err := NewPostgresJournals(ctx, superuserPool, server.superuserURL, journalTestKey)
	require.NoError(t, err)
	for _, attribute := range []string{"BYPASSRLS", "REPLICATION", "SUPERUSER"} {
		_, err = server.superuser.Exec(ctx, "ALTER ROLE "+first.Name+" "+attribute)
		require.NoError(t, err)
		_, err = journals.Provision(ctx, workspace)
		require.Error(t, err, attribute)
		assert.Regexp(t, "permission denied|server privilege", err.Error(), attribute)
		_, err = asSuperuser.Provision(ctx, workspace)
		require.ErrorContains(t, err, "server privilege", attribute)
		_, err = server.superuser.Exec(ctx, "ALTER ROLE "+first.Name+" NO"+attribute)
		require.NoError(t, err)
	}
	_, err = journals.Provision(ctx, workspace)
	require.NoError(t, err)
}

func TestPostgresJournalsRefuseWhenTheRoleCouldReachTheBackend(t *testing.T) {
	// The backend does not own its database, so it cannot revoke PUBLIC's
	// CONNECT: provisioning refuses rather than hand out a credential that
	// opens the backend database.
	server := newJournalServer(t, false)
	ctx := context.Background()
	journals, err := NewPostgresJournals(ctx, server.pool, server.adminURL, journalTestKey)
	require.NoError(t, err)
	workspace := uuid.NewString()
	name, err := JournalDatabaseName(workspace)
	require.NoError(t, err)
	server.names = append(server.names, name)
	_, err = journals.Provision(ctx, workspace)
	require.ErrorContains(t, err, "revoke CONNECT")

	// Once the operator revokes it, the same start succeeds.
	_, err = server.superuser.Exec(ctx, "REVOKE CONNECT, TEMPORARY ON DATABASE "+pgx.Identifier{server.backend}.Sanitize()+" FROM PUBLIC")
	require.NoError(t, err)
	_, err = journals.Provision(ctx, workspace)
	require.NoError(t, err)

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = journals.Provision(cancelled, uuid.NewString())
	require.Error(t, err)
	_, err = journals.Provision(ctx, "workspace-1")
	require.Error(t, err)
	deadline, stop := context.WithTimeout(ctx, time.Nanosecond)
	defer stop()
	<-deadline.Done()
	_, err = NewPostgresJournals(deadline, server.pool, server.adminURL, journalTestKey)
	require.Error(t, err)
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	require.NoError(t, err)
	return parsed
}
