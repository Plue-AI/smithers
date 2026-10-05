package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// Literal mirror fixture: main's files, the one line JOURNEY.md holds and the
// mirror's local slug.
const (
	mirrorReadOwner    = "acme"
	mirrorReadSlugName = "app-mirror"
	mirrorReadJourney  = "Add a greeting to JOURNEY.md\n"
	mirrorReadOverflow = 16*1024*1024 + 1
)

type mirrorReadFixture struct {
	t        *testing.T
	pool     *pgxpool.Pool
	reader   InstallSource
	owner    db.User
	member   db.User
	stranger db.User
	mirror   int64
	other    int64
	commit   string
}

// everyMember is the member-boundary seam for the cases about repository
// permission; the installation's own boundary is exercised on its own below.
type everyMember struct{}

func (everyMember) AuthorizeMember(context.Context, int64) *pkgerrors.APIError { return nil }

// newMirrorReadFixture builds the install as Source ready leaves it: a private
// mirror of main in a real repository host (jj and git stores, read by the
// Rust engine), its owner, a read collaborator, a stranger and a second
// repository the owner also holds. Setup is not marked ready here.
func newMirrorReadFixture(t *testing.T) *mirrorReadFixture {
	t.Helper()
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to the built smithers-ffi library")
	}
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	user := func(name string) db.User {
		created, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name})
		require.NoError(t, err)
		return created
	}
	f := &mirrorReadFixture{t: t, pool: pool, owner: user(mirrorReadOwner), member: user("maya"), stranger: user("mallory")}
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, f.owner.ID)
	require.NoError(t, err)
	repository := func(name string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark,is_public) VALUES ($1,$2,$2,'main',false) RETURNING id`, f.owner.ID, name).Scan(&id))
		return id
	}
	f.mirror, f.other = repository(mirrorReadSlugName), repository("other")
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'read')`, f.mirror, f.member.ID)
	require.NoError(t, err)

	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "install-source", FFILibraryPath: library}
	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	store := func(name string, files map[string]string, links map[string]string, gitlinks map[string]string) string {
		repoPath, gitDir := cfg.RepoPath(mirrorReadOwner, name), cfg.GitBackendPath(mirrorReadOwner, name)
		_, err := native.InitRepo(repoPath)
		require.NoError(t, err)
		git := func(stdin string, env []string, args ...string) string {
			t.Helper()
			cmd := exec.Command("git", append([]string{"--git-dir", gitDir}, args...)...)
			cmd.Env = append(append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.invalid", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.invalid"), env...)
			cmd.Stdin = strings.NewReader(stdin)
			out, err := cmd.CombinedOutput()
			require.NoError(t, err, "git %v: %s", args, out)
			return strings.TrimSpace(string(out))
		}
		index := []string{"GIT_INDEX_FILE=" + filepath.Join(t.TempDir(), "index")}
		for path, body := range files {
			blob := git(body, nil, "hash-object", "-w", "--stdin")
			git("", index, "update-index", "--add", "--cacheinfo", "100644,"+blob+","+path)
		}
		for path, target := range links {
			blob := git(target, nil, "hash-object", "-w", "--stdin")
			git("", index, "update-index", "--add", "--cacheinfo", "120000,"+blob+","+path)
		}
		// A submodule is a gitlink: a commit id in the tree, not a blob.
		for path, commit := range gitlinks {
			git("", index, "update-index", "--add", "--cacheinfo", "160000,"+commit+","+path)
		}
		commit := git("", nil, "commit-tree", git("", index, "write-tree"), "-m", "main")
		git("", nil, "update-ref", "refs/heads/main", commit)
		require.NoError(t, native.ImportGitRefs(repoPath))
		return commit
	}
	f.commit = store(mirrorReadSlugName, map[string]string{
		"JOURNEY.md":     mirrorReadJourney,
		"docs/guide.md":  "Read me second.\n",
		"bin/blob.dat":   "\x00\x01\x02 not text",
		"bad-utf8.txt":   "\xff\xfe\xfd",
		"big.txt":        strings.Repeat("a", mirrorReadOverflow),
		"  spaced name ": "kept exactly\n",
	}, map[string]string{
		"link":   "JOURNEY.md",
		"escape": "/etc/passwd",
		"up":     "..",
	}, map[string]string{
		"vendor/lib": strings.Repeat("1", 40),
	})
	store("other", map[string]string{"SECRET.md": "other repository\n"}, nil, nil)
	backend, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	server := httptest.NewServer(backend.Handler())
	t.Cleanup(server.Close)
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, cfg.AuthToken)
	f.reader = InstallSource{Pool: pool, Repos: NewRepoService(q, client, ""), Members: everyMember{}}
	return f
}

// setting writes one install setting as the setup steps do.
func (f *mirrorReadFixture) setting(key, value string) {
	f.t.Helper()
	require.NoError(f.t, db.New(f.pool).UpsertInstallSetting(f.t.Context(), db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
}

// ready records what the source step leaves when the mirror holds main.
func (f *mirrorReadFixture) ready() {
	slug, _ := json.Marshal(mirrorReadOwner + "/" + mirrorReadSlugName)
	f.setting("setup.source.repository", string(slug))
	f.setting("setup.step.source", `{"status":"done"}`)
}

// session signs user in through a browser and returns the session as a turn
// keeps it, by its storage key.
func (f *mirrorReadFixture) session(user db.User, expires time.Time) middleware.Credential {
	return turnSession(f.t, f.pool, user, expires)
}

// token mints an API token for user with the given stored scopes and returns
// it as a turn keeps it, by its hash, with the token row's id.
func (f *mirrorReadFixture) token(user db.User, scopes string, systemIssued bool, expires pgtype.Timestamptz) (middleware.Credential, int64) {
	return turnToken(f.t, f.pool, user, scopes, systemIssued, expires)
}

// turnSession signs user in through a browser and returns the session as a
// turn keeps it, by its storage key.
func turnSession(t *testing.T, pool *pgxpool.Pool, user db.User, expires time.Time) middleware.Credential {
	t.Helper()
	sum := sha256.Sum256([]byte(uuid.NewString()))
	key := hex.EncodeToString(sum[:])
	_, err := db.New(pool).CreateAuthSession(t.Context(), db.CreateAuthSessionParams{SessionKey: key, UserID: user.ID, Username: user.Username, ExpiresAt: expires})
	require.NoError(t, err)
	return middleware.Credential{SessionHash: key}
}

// turnToken mints an API token for user with the given stored scopes and
// returns it as a turn keeps it, by its hash, with the token row's id.
func turnToken(t *testing.T, pool *pgxpool.Pool, user db.User, scopes string, systemIssued bool, expires pgtype.Timestamptz) (middleware.Credential, int64) {
	t.Helper()
	sum := sha256.Sum256([]byte(uuid.NewString()))
	hash := hex.EncodeToString(sum[:])
	created, err := db.New(pool).CreateAccessToken(t.Context(), db.CreateAccessTokenParams{
		UserID: user.ID, Name: "turn-" + hash[:8], TokenHash: hash, TokenLastEight: hash[:8], Scopes: scopes, ExpiresAt: expires, SystemIssued: systemIssued,
	})
	require.NoError(t, err)
	return middleware.Credential{TokenHash: hash}, created.ID
}

// browser is a live browser session for user.
func (f *mirrorReadFixture) browser(user db.User) middleware.Credential {
	return f.session(user, time.Now().Add(time.Hour))
}

func TestAgentSourceReadRefusesBeforeSourceReady(t *testing.T) {
	f := newMirrorReadFixture(t)
	ctx := context.Background()
	owner := f.browser(f.owner)
	_, err := f.reader.Source(ctx, owner, f.owner.ID, 0)
	require.ErrorIs(t, err, ErrSourceNotReady)
	_, err = f.reader.ReadSource(ctx, owner, f.owner.ID, 0, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceNotReady)
	// The mirror's slug without a finished step is still not Source ready.
	f.setting("setup.source.repository", `"acme/app-mirror"`)
	f.setting("setup.step.source", `{"status":"running"}`)
	_, err = f.reader.ReadSource(ctx, owner, f.owner.ID, 0, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceNotReady)
}

func TestAgentSourceReadServesMainToTheAskingMember(t *testing.T) {
	f := newMirrorReadFixture(t)
	f.ready()
	ctx := context.Background()
	readToken, _ := f.token(f.owner, "read:repository,write:user", false, pgtype.Timestamptz{})
	for _, asker := range []struct {
		user       db.User
		credential middleware.Credential
	}{{f.owner, f.browser(f.owner)}, {f.member, f.browser(f.member)}, {f.owner, readToken}} {
		repository, err := f.reader.Source(ctx, asker.credential, asker.user.ID, 0)
		require.NoError(t, err)
		require.Equal(t, "acme/app-mirror", repository)
		file, err := f.reader.ReadSource(ctx, asker.credential, asker.user.ID, 0, "JOURNEY.md")
		require.NoError(t, err)
		require.Equal(t, SourceFile{Repository: "acme/app-mirror", Path: "JOURNEY.md", Commit: f.commit, Content: mirrorReadJourney}, file)
	}
	owner, member := f.browser(f.owner), f.browser(f.member)
	// A turn already scoped to the mirror reads it; whitespace in a name is exact.
	file, err := f.reader.ReadSource(ctx, member, f.member.ID, f.mirror, "  spaced name ")
	require.NoError(t, err)
	require.Equal(t, "kept exactly\n", file.Content)
	file, err = f.reader.ReadSource(ctx, owner, f.owner.ID, 0, "docs/guide.md")
	require.NoError(t, err)
	require.Equal(t, "Read me second.\n", file.Content)
	// Binary bytes are stated, never returned: a NUL byte and invalid UTF-8.
	for _, path := range []string{"bin/blob.dat", "bad-utf8.txt"} {
		file, err = f.reader.ReadSource(ctx, owner, f.owner.ID, 0, path)
		require.NoError(t, err)
		require.Equal(t, SourceFile{Repository: "acme/app-mirror", Path: path, Commit: f.commit, Binary: true}, file)
	}
}

func TestAgentSourceReadRefusesPathsOutsideTheRepository(t *testing.T) {
	f := newMirrorReadFixture(t)
	f.ready()
	ctx := context.Background()
	owner := f.browser(f.owner)
	refused := []string{
		"", "/JOURNEY.md", "/etc/passwd", "../JOURNEY.md", "../other/SECRET.md", "docs/../JOURNEY.md",
		"./JOURNEY.md", "docs/./guide.md", "docs//guide.md", "docs/", "..", ".",
		"JOURNEY.md\x00", "\xffJOURNEY.md", strings.Repeat("a/", 2048) + "b",
	}
	for _, path := range refused {
		file, err := f.reader.ReadSource(ctx, owner, f.owner.ID, 0, path)
		require.ErrorIs(t, err, ErrSourcePathRefused, "path %q", path)
		require.Equal(t, SourceFile{}, file)
	}
	// Symlinks are not followed: not to a file in the tree, not out of it, and
	// not as a directory on the way to a file. A directory and a submodule are
	// not files. An escaped separator, a backslash and a revision selector are
	// part of a name, so they name no file here, and another repository's
	// file is not in this tree.
	for _, path := range []string{
		"link", "escape", "up/JOURNEY.md", "up/up/etc/passwd", "docs", "vendor/lib", "vendor/lib/README.md", "missing.md", "SECRET.md",
		"docs%2Fguide.md", `docs\guide.md`, "JOURNEY.md?ref=x", "JOURNEY.md@{1}", "JOURNEY.md#main",
	} {
		file, err := f.reader.ReadSource(ctx, owner, f.owner.ID, 0, path)
		require.ErrorIs(t, err, ErrSourceNotFound, "path %q", path)
		require.Equal(t, SourceFile{}, file)
	}
	// The repository host's blob cap bounds a read; nothing is returned.
	file, err := f.reader.ReadSource(ctx, owner, f.owner.ID, 0, "big.txt")
	require.ErrorIs(t, err, ErrSourceTooLarge)
	require.Equal(t, SourceFile{}, file)
}

func TestAgentSourceReadIsAuthorizedAsTheAskingMember(t *testing.T) {
	f := newMirrorReadFixture(t)
	f.ready()
	ctx := context.Background()
	// A stranger to the private mirror and a turn scoped to another
	// repository read nothing and are offered no source.
	stranger, owner, member := f.browser(f.stranger), f.browser(f.owner), f.browser(f.member)
	for _, refused := range []struct {
		credential       middleware.Credential
		user, repository int64
	}{{stranger, f.stranger.ID, 0}, {owner, f.owner.ID, f.other}, {member, f.member.ID, f.other}} {
		_, err := f.reader.Source(ctx, refused.credential, refused.user, refused.repository)
		require.ErrorIs(t, err, ErrSourceForbidden)
		file, err := f.reader.ReadSource(ctx, refused.credential, refused.user, refused.repository, "JOURNEY.md")
		require.ErrorIs(t, err, ErrSourceForbidden)
		require.Equal(t, SourceFile{}, file)
	}
	// Losing access ends reads at once; the check runs per read.
	_, err := f.reader.ReadSource(ctx, member, f.member.ID, 0, "JOURNEY.md")
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, f.mirror, f.member.ID)
	require.NoError(t, err)
	_, err = f.reader.ReadSource(ctx, member, f.member.ID, 0, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceForbidden)
}

// A read carries the authority of the credential that admitted the turn, as
// that credential stands at the read, never more than the route it would
// need to read the same file.
func TestAgentSourceReadCarriesTheAdmittingCredentialsAuthority(t *testing.T) {
	f := newMirrorReadFixture(t)
	f.ready()
	ctx := context.Background()
	q := db.New(f.pool)
	never := pgtype.Timestamptz{}
	refuses := func(credential middleware.Credential, userID int64, why string) {
		t.Helper()
		_, err := f.reader.Source(ctx, credential, userID, 0)
		require.ErrorIs(t, err, ErrSourceForbidden, why)
		file, err := f.reader.ReadSource(ctx, credential, userID, 0, "JOURNEY.md")
		require.ErrorIs(t, err, ErrSourceForbidden, why)
		require.Equal(t, SourceFile{}, file, why)
	}
	reads := func(credential middleware.Credential, userID int64, why string) {
		t.Helper()
		file, err := f.reader.ReadSource(ctx, credential, userID, 0, "JOURNEY.md")
		require.NoError(t, err, why)
		require.Equal(t, mirrorReadJourney, file.Content, why)
	}
	userOnly, _ := f.token(f.owner, "write:user", false, never)
	refuses(userOnly, f.owner.ID, "a token that may chat but not read repositories")
	repoBound, _ := f.token(f.owner, "read:repository,"+middleware.RepositoryRestrictionScope(f.mirror), false, never)
	refuses(repoBound, f.owner.ID, "a token bound to one repository acts on its routes only")
	pathBound, _ := f.token(f.owner, strings.Join(append([]string{"read:repository"}, middleware.PathRestrictionScopes([]string{"docs"})...), ","), false, never)
	refuses(pathBound, f.owner.ID, "a token bound to paths")
	runToken, _ := f.token(f.owner, "read:repository,write:user", true, never)
	refuses(runToken, f.owner.ID, "an agent run's token is not a person's")
	expiredToken, _ := f.token(f.owner, "read:repository", false, pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true})
	refuses(expiredToken, f.owner.ID, "an expired token")
	refuses(f.session(f.owner, time.Now().Add(-time.Minute)), f.owner.ID, "an expired session")
	refuses(middleware.Credential{}, f.owner.ID, "no credential")
	refuses(middleware.Credential{SessionHash: strings.Repeat("0", 64)}, f.owner.ID, "an unknown session")
	refuses(f.browser(f.owner), f.member.ID, "another account's credential")
	refuses(middleware.Credential{TokenHash: "a", SessionHash: "b"}, f.owner.ID, "a credential naming two")

	// Revoking the credential mid-turn ends the turn's reads at the next one.
	readToken, tokenID := f.token(f.owner, "read:repository", false, never)
	reads(readToken, f.owner.ID, "a person's read token")
	require.NoError(t, q.DeleteAccessToken(ctx, db.DeleteAccessTokenParams{ID: tokenID, UserID: f.owner.ID}))
	refuses(readToken, f.owner.ID, "a revoked token")
	browser := f.browser(f.owner)
	reads(browser, f.owner.ID, "a browser session")
	require.NoError(t, q.DeleteAuthSession(ctx, browser.SessionHash))
	refuses(browser, f.owner.ID, "a signed-out session")

	// A suspended, disabled or deleted account reads nothing with any credential.
	member, memberToken := f.browser(f.member), func() middleware.Credential {
		credential, _ := f.token(f.member, "read:repository", false, never)
		return credential
	}()
	reads(member, f.member.ID, "the member's session")
	reads(memberToken, f.member.ID, "the member's token")
	for _, state := range []string{"prohibit_login=true", "is_active=false", "deleted_at=now()"} {
		_, err := f.pool.Exec(ctx, `UPDATE users SET `+state+` WHERE id=$1`, f.member.ID)
		require.NoError(t, err)
		refuses(member, f.member.ID, state+" session")
		refuses(memberToken, f.member.ID, state+" token")
		_, err = f.pool.Exec(ctx, `UPDATE users SET prohibit_login=false,is_active=true,deleted_at=NULL WHERE id=$1`, f.member.ID)
		require.NoError(t, err)
		reads(member, f.member.ID, "restored after "+state)
	}
}

// The installation's member boundary, the one AuthLoader applies, also
// bounds every read: an owner whose GitHub access is unverified, or anyone
// but the owner, reads nothing.
func TestAgentSourceReadIsBoundedByTheInstallationMembers(t *testing.T) {
	f := newMirrorReadFixture(t)
	f.ready()
	ctx := context.Background()
	f.reader.Members = identity.NewMemberBoundary(db.New(f.pool))
	owner, member := f.browser(f.owner), f.browser(f.member)
	_, err := f.reader.Source(ctx, owner, f.owner.ID, 0)
	require.ErrorIs(t, err, ErrSourceForbidden, "owner_unverified")
	access := `{"owner_login":"acme","repository_name":"app","repository_id":42}`
	f.setting("github.repository", access)
	f.setting("owner.access", `{"last_access_check_at":"`+time.Now().UTC().Format(time.RFC3339Nano)+`","owner_login":"acme","repository_name":"app","repository_id":42}`)
	file, err := f.reader.ReadSource(ctx, owner, f.owner.ID, 0, "JOURNEY.md")
	require.NoError(t, err)
	require.Equal(t, mirrorReadJourney, file.Content)
	_, err = f.reader.ReadSource(ctx, member, f.member.ID, 0, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceForbidden, "a collaborator who is not the installation's owner")
	// Without a boundary nothing is read.
	f.reader.Members = nil
	_, err = f.reader.ReadSource(ctx, owner, f.owner.ID, 0, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceForbidden)
}
