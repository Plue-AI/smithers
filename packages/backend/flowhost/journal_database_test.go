package flowhost

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"slices"
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
	// A parameter the host's driver would read as its identity or database
	// is refused, so a configured credential never reaches a host.
	for _, parameter := range []string{"user=postgres", "password=backend-secret", "dbname=smithers", "host=other", "options=-c%20role%3Dpostgres", "schema=public"} {
		_, err = NewPostgresJournals(ctx, pool, "postgres://db:5432/?sslmode=require&"+parameter, journalTestKey)
		require.ErrorContains(t, err, "transport parameters", parameter)
		assert.NotContains(t, err.Error(), "backend-secret")
	}
}

func TestJournalIdentityNamesTheEndpointNotTheCredential(t *testing.T) {
	workspace := uuid.NewString()
	describe := func(address string, key []byte) JournalDatabase {
		journal, err := (&PostgresJournals{address: mustURL(t, address), key: key}).Describe(workspace)
		require.NoError(t, err)
		return journal
	}
	base := describe("postgres://journal.internal:5432/?sslmode=require", journalTestKey)
	assert.Empty(t, JournalDatabase{}.identity(), "a SQLite host keeps its identity")
	password, _ := mustURL(t, base.URL).User.Password()
	assert.NotContains(t, base.identity(), password)
	assert.Contains(t, base.identity(), base.Name)
	assert.Equal(t, base.identity(), describe("postgres://journal.internal:5432/?sslmode=require", []byte(strings.Repeat("r", 32))).identity())
	for _, moved := range []string{"postgres://other.internal:5432/?sslmode=require", "postgres://journal.internal:6543/?sslmode=require", "postgres://journal.internal:5432/?sslmode=disable"} {
		assert.NotEqual(t, base.identity(), describe(moved, journalTestKey).identity(), moved)
	}
	assert.Equal(t, base.Name, JournalDatabase{Name: base.Name, URL: "postgres://%zz"}.identity())
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

	// A provision interrupted between creating the database (which refuses
	// connections until PUBLIC's grant is gone) and opening it completes on
	// the next start.
	_, err = server.superuser.Exec(ctx, "ALTER DATABASE "+first.Name+" WITH ALLOW_CONNECTIONS false")
	require.NoError(t, err)
	_, err = pgx.Connect(ctx, first.URL)
	require.Error(t, err)
	_, err = journals.Provision(ctx, workspace)
	require.NoError(t, err)
	var open bool
	require.NoError(t, server.superuser.QueryRow(ctx, `SELECT datallowconn FROM pg_database WHERE datname = $1`, first.Name).Scan(&open))
	assert.True(t, open)

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

func TestJournalWorkspaceIDAcceptsOnlyTheJournalScheme(t *testing.T) {
	workspace := "0f1e2d3c-4b5a-4968-8776-655443322110"
	name, err := JournalDatabaseName(workspace)
	require.NoError(t, err)
	parsed, err := JournalWorkspaceID(name)
	require.NoError(t, err)
	assert.Equal(t, workspace, parsed)
	for _, foreign := range []string{
		"", "smithers_flows_", "smithers_flows_keep", "postgres", "smithers_test_journal_admin_0f1e2d3c",
		strings.ToUpper(name), "smithers_flows_" + strings.ToUpper(name[len("smithers_flows_"):]),
		name + "0", name[:len(name)-1], "x" + name, "smithers_flows_0f1e2d3c-4b5a-4968-8776-655443322110",
		name + "\n", "smithers_flows_0f1e2d3c4b5a49688776655443322g10",
	} {
		_, err = JournalWorkspaceID(foreign)
		require.Error(t, err, foreign)
	}
}

func (server *journalServer) exists(t *testing.T, name string) (role, database bool) {
	t.Helper()
	require.NoError(t, server.superuser.QueryRow(context.Background(), `SELECT
		EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1), EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&role, &database))
	return role, database
}

func TestPostgresJournalsDropRemovesTheWorkspaceJournalOnly(t *testing.T) {
	server := newJournalServer(t, true)
	ctx := context.Background()
	// One connection, so every check below sees the session Drop used.
	config, err := pgxpool.ParseConfig(server.adminURL)
	require.NoError(t, err)
	config.MaxConns = 1
	single, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	defer single.Close()
	journals, err := NewPostgresJournals(ctx, single, server.adminURL, journalTestKey)
	require.NoError(t, err)
	deleted, kept := uuid.NewString(), uuid.NewString()
	journal := server.provisioned(t, journals, deleted)
	other := server.provisioned(t, journals, kept)

	// A host still connected to the journal does not block the drop.
	live, err := pgx.Connect(ctx, journal.URL)
	require.NoError(t, err)
	defer live.Close(ctx)
	_, err = live.Exec(ctx, "CREATE SCHEMA flows_control_db")
	require.NoError(t, err)

	require.NoError(t, journals.Drop(ctx, deleted))
	role, database := server.exists(t, journal.Name)
	assert.False(t, role || database)
	require.Error(t, live.Ping(ctx))
	_, err = pgx.Connect(ctx, journal.URL)
	require.Error(t, err)
	role, database = server.exists(t, other.Name)
	assert.True(t, role && database, "another workspace's journal survives")
	var current string
	require.NoError(t, single.QueryRow(ctx, `SELECT current_user`).Scan(&current))
	assert.Equal(t, mustURL(t, server.adminURL).User.Username(), current, "the pooled session is the backend again")

	// Idempotent: a repeat, a workspace that never had a journal, and a role
	// whose database an operator already dropped.
	require.NoError(t, journals.Drop(ctx, deleted))
	require.NoError(t, journals.Drop(ctx, uuid.NewString()))
	_, err = server.superuser.Exec(ctx, "DROP DATABASE "+other.Name+" WITH (FORCE)")
	require.NoError(t, err)
	require.NoError(t, journals.Drop(ctx, kept))
	role, database = server.exists(t, other.Name)
	assert.False(t, role || database)

	// A provision interrupted before the backend held the role's membership
	// is still dropped.
	interrupted := server.provisioned(t, journals, uuid.NewString())
	interruptedID, err := JournalWorkspaceID(interrupted.Name)
	require.NoError(t, err)
	admin := mustURL(t, server.adminURL).User.Username()
	_, err = server.superuser.Exec(ctx, "REVOKE "+interrupted.Name+" FROM "+admin+" GRANTED BY "+admin)
	require.NoError(t, err)
	var canSet bool
	require.NoError(t, server.superuser.QueryRow(ctx, `SELECT pg_has_role($1, $2, 'SET')`, admin, interrupted.Name).Scan(&canSet))
	require.False(t, canSet)
	require.NoError(t, journals.Drop(ctx, interruptedID))
	role, database = server.exists(t, interrupted.Name)
	assert.False(t, role || database)

	// A superuser backend (the local embedded server) drops the same way.
	superuserPool, err := pgxpool.New(ctx, server.superuserURL)
	require.NoError(t, err)
	defer superuserPool.Close()
	asSuperuser, err := NewPostgresJournals(ctx, superuserPool, server.superuserURL, journalTestKey)
	require.NoError(t, err)
	superuserWorkspace := uuid.NewString()
	superuserJournal := server.provisioned(t, asSuperuser, superuserWorkspace)
	require.NoError(t, asSuperuser.Drop(ctx, superuserWorkspace))
	role, database = server.exists(t, superuserJournal.Name)
	assert.False(t, role || database)

	require.ErrorContains(t, journals.Drop(ctx, "smithers_flows_keep"), "canonical workspace id")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	require.Error(t, journals.Drop(cancelled, uuid.NewString()))
}

func TestPostgresJournalsWorkspacesListsOnlyThisBackendsJournals(t *testing.T) {
	server := newJournalServer(t, true)
	ctx := context.Background()
	journals, err := NewPostgresJournals(ctx, server.pool, server.adminURL, journalTestKey)
	require.NoError(t, err)
	listed, err := journals.Workspaces(ctx)
	require.NoError(t, err)
	assert.Empty(t, listed)
	first, second := uuid.NewString(), uuid.NewString()
	server.provisioned(t, journals, first)
	server.provisioned(t, journals, second)

	// Roles a sweep must never see: outside the naming scheme though tagged
	// as this backend's, another backend's journal, and an untagged one.
	tag := quoteLiteral("smithers flow journal of database " + server.backend)
	foreignName, err := JournalDatabaseName(uuid.NewString())
	require.NoError(t, err)
	untaggedName, err := JournalDatabaseName(uuid.NewString())
	require.NoError(t, err)
	decoys := map[string]string{
		"smithers_flows_keep": tag,
		`"SMITHERS_FLOWS_` + strings.ToUpper(foreignName[len("smithers_flows_"):]) + `"`: tag,
		foreignName:  quoteLiteral("smithers flow journal of database another_backend"),
		untaggedName: "",
	}
	for role, comment := range decoys {
		_, err = server.superuser.Exec(ctx, "CREATE ROLE "+role)
		require.NoError(t, err)
		t.Cleanup(func() { _, _ = server.superuser.Exec(context.Background(), "DROP ROLE IF EXISTS "+role) })
		if comment != "" {
			_, err = server.superuser.Exec(ctx, "COMMENT ON ROLE "+role+" IS "+comment)
			require.NoError(t, err)
		}
	}

	listed, err = journals.Workspaces(ctx)
	require.NoError(t, err)
	expected := []string{first, second}
	slices.Sort(expected)
	assert.Equal(t, expected, listed)

	require.NoError(t, journals.Drop(ctx, first))
	listed, err = journals.Workspaces(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{second}, listed)
	for role := range decoys {
		var exists bool
		require.NoError(t, server.superuser.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`,
			strings.Trim(role, `"`)).Scan(&exists))
		assert.True(t, exists, role)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = journals.Workspaces(cancelled)
	require.Error(t, err)
}

func TestResealJournalPasswordsRetiresTheReplacedKeysPasswordsPostgres(t *testing.T) {
	server := newJournalServer(t, true)
	ctx := context.Background()
	journals, err := NewPostgresJournals(ctx, server.pool, server.adminURL, JournalKey("old-operator-key"))
	require.NoError(t, err)
	first, second := uuid.NewString(), uuid.NewString()
	oldFirst := server.provisioned(t, journals, first)
	oldSecond := server.provisioned(t, journals, second)
	live, err := pgx.Connect(ctx, oldFirst.URL)
	require.NoError(t, err)
	defer live.Close(ctx)

	// Another backend's journal on the same server keeps its password.
	other := newJournalServer(t, true)
	otherJournals, err := NewPostgresJournals(ctx, other.pool, other.adminURL, JournalKey("old-operator-key"))
	require.NoError(t, err)
	foreign := other.provisioned(t, otherJournals, uuid.NewString())

	resealed, err := ResealJournalPasswords(ctx, server.pool, "new-operator-key")
	require.NoError(t, err)
	assert.Equal(t, 2, resealed)

	for _, old := range []JournalDatabase{oldFirst, oldSecond} {
		_, err = pgx.Connect(ctx, old.URL)
		require.ErrorContains(t, err, "password authentication failed", old.Name)
	}
	rotated, err := NewPostgresJournals(ctx, server.pool, server.adminURL, JournalKey("new-operator-key"))
	require.NoError(t, err)
	for _, workspace := range []string{first, second} {
		current, err := rotated.Describe(workspace)
		require.NoError(t, err)
		conn, err := pgx.Connect(ctx, current.URL)
		require.NoError(t, err, workspace)
		require.NoError(t, conn.Close(ctx))
	}
	// A session opened before the rotation is not cut off.
	require.NoError(t, live.Ping(ctx))
	conn, err := pgx.Connect(ctx, foreign.URL)
	require.NoError(t, err)
	require.NoError(t, conn.Close(ctx))

	// Idempotent, and a role dropped after listing is skipped.
	resealed, err = ResealJournalPasswords(ctx, server.pool, "new-operator-key")
	require.NoError(t, err)
	assert.Equal(t, 2, resealed)
	changed, err := rotated.resealPassword(ctx, uuid.NewString())
	require.NoError(t, err)
	assert.False(t, changed)
	require.NoError(t, rotated.Drop(ctx, second))
	resealed, err = ResealJournalPasswords(ctx, server.pool, "new-operator-key")
	require.NoError(t, err)
	assert.Equal(t, 1, resealed)
}

func TestResealJournalPasswordsRefusesMissingInputs(t *testing.T) {
	_, err := ResealJournalPasswords(context.Background(), nil, "key")
	require.ErrorContains(t, err, "backend pool and the operator key")
	pool, err := pgxpool.New(context.Background(), "postgres://127.0.0.1:1/none")
	require.NoError(t, err)
	defer pool.Close()
	_, err = ResealJournalPasswords(context.Background(), pool, "")
	require.ErrorContains(t, err, "backend pool and the operator key")
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = ResealJournalPasswords(cancelled, pool, "key")
	require.ErrorContains(t, err, "flow journals")
}

func TestJournalKeyDependsOnlyOnTheOperatorKey(t *testing.T) {
	assert.Equal(t, JournalKey("a"), JournalKey("a"))
	assert.NotEqual(t, JournalKey("a"), JournalKey("b"))
	assert.Len(t, JournalKey(""), 32)
}

func TestResealJournalPasswordsResumesAfterAPartialPassPostgres(t *testing.T) {
	server := newJournalServer(t, true)
	ctx := context.Background()
	journals, err := NewPostgresJournals(ctx, server.pool, server.adminURL, JournalKey("old-operator-key"))
	require.NoError(t, err)
	workspaces := []string{uuid.NewString(), uuid.NewString()}
	slices.Sort(workspaces) // resealed in this order
	old := []JournalDatabase{server.provisioned(t, journals, workspaces[0]), server.provisioned(t, journals, workspaces[1])}
	// A role the backend may no longer alter stops the pass after the first.
	_, err = server.superuser.Exec(ctx, "ALTER ROLE "+old[1].Name+" SUPERUSER")
	require.NoError(t, err)
	resealed, err := ResealJournalPasswords(ctx, server.pool, "new-operator-key")
	require.ErrorContains(t, err, "flow journal role password")
	assert.Equal(t, 1, resealed)
	_, err = pgx.Connect(ctx, old[0].URL)
	require.ErrorContains(t, err, "password authentication failed")
	_, err = server.superuser.Exec(ctx, "ALTER ROLE "+old[1].Name+" NOSUPERUSER")
	require.NoError(t, err)
	conn, err := pgx.Connect(ctx, old[1].URL)
	require.NoError(t, err, "the role the pass stopped at keeps its password")
	require.NoError(t, conn.Close(ctx))

	// Running again with the same key finishes the rotation.
	resealed, err = ResealJournalPasswords(ctx, server.pool, "new-operator-key")
	require.NoError(t, err)
	assert.Equal(t, 2, resealed)
	rotated, err := NewPostgresJournals(ctx, server.pool, server.adminURL, JournalKey("new-operator-key"))
	require.NoError(t, err)
	for index, workspace := range workspaces {
		_, err = pgx.Connect(ctx, old[index].URL)
		require.ErrorContains(t, err, "password authentication failed")
		current, err := rotated.Describe(workspace)
		require.NoError(t, err)
		conn, err := pgx.Connect(ctx, current.URL)
		require.NoError(t, err)
		require.NoError(t, conn.Close(ctx))
	}
}
