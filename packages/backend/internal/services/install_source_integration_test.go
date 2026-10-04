package services

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
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
	store := func(name string, files map[string]string, links map[string]string) string {
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
	})
	store("other", map[string]string{"SECRET.md": "other repository\n"}, nil)
	backend, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	server := httptest.NewServer(backend.Handler())
	t.Cleanup(server.Close)
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, cfg.AuthToken)
	f.reader = InstallSource{Pool: pool, Repos: NewRepoService(q, client, "")}
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

func TestAgentSourceReadRefusesBeforeSourceReady(t *testing.T) {
	f := newMirrorReadFixture(t)
	ctx := context.Background()
	_, err := f.reader.Source(ctx, f.owner.ID, 0)
	require.ErrorIs(t, err, ErrSourceNotReady)
	_, err = f.reader.ReadSource(ctx, f.owner.ID, 0, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceNotReady)
	// The mirror's slug without a finished step is still not Source ready.
	f.setting("setup.source.repository", `"acme/app-mirror"`)
	f.setting("setup.step.source", `{"status":"running"}`)
	_, err = f.reader.ReadSource(ctx, f.owner.ID, 0, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceNotReady)
}

func TestAgentSourceReadServesMainToTheAskingMember(t *testing.T) {
	f := newMirrorReadFixture(t)
	f.ready()
	ctx := context.Background()
	for _, user := range []db.User{f.owner, f.member} {
		repository, err := f.reader.Source(ctx, user.ID, 0)
		require.NoError(t, err)
		require.Equal(t, "acme/app-mirror", repository)
		file, err := f.reader.ReadSource(ctx, user.ID, 0, "JOURNEY.md")
		require.NoError(t, err)
		require.Equal(t, SourceFile{Repository: "acme/app-mirror", Path: "JOURNEY.md", Commit: f.commit, Content: mirrorReadJourney}, file)
	}
	// A turn already scoped to the mirror reads it; whitespace in a name is exact.
	file, err := f.reader.ReadSource(ctx, f.member.ID, f.mirror, "  spaced name ")
	require.NoError(t, err)
	require.Equal(t, "kept exactly\n", file.Content)
	file, err = f.reader.ReadSource(ctx, f.owner.ID, 0, "docs/guide.md")
	require.NoError(t, err)
	require.Equal(t, "Read me second.\n", file.Content)
	// Binary bytes are stated, never returned: a NUL byte and invalid UTF-8.
	for _, path := range []string{"bin/blob.dat", "bad-utf8.txt"} {
		file, err = f.reader.ReadSource(ctx, f.owner.ID, 0, path)
		require.NoError(t, err)
		require.Equal(t, SourceFile{Repository: "acme/app-mirror", Path: path, Commit: f.commit, Binary: true}, file)
	}
}

func TestAgentSourceReadRefusesPathsOutsideTheRepository(t *testing.T) {
	f := newMirrorReadFixture(t)
	f.ready()
	ctx := context.Background()
	refused := []string{
		"", "/JOURNEY.md", "/etc/passwd", "../JOURNEY.md", "../other/SECRET.md", "docs/../JOURNEY.md",
		"./JOURNEY.md", "docs/./guide.md", "docs//guide.md", "docs/", "..", ".",
		`docs\guide.md`, "JOURNEY.md\x00", "\xffJOURNEY.md", strings.Repeat("a/", 2048) + "b",
	}
	for _, path := range refused {
		file, err := f.reader.ReadSource(ctx, f.owner.ID, 0, path)
		require.ErrorIs(t, err, ErrSourcePathRefused, "path %q", path)
		require.Equal(t, SourceFile{}, file)
	}
	// Symlinks are not followed: not to a file in the tree, not out of it, and
	// not as a directory on the way to a file. A directory is not a file.
	for _, path := range []string{"link", "escape", "up/JOURNEY.md", "up/up/etc/passwd", "docs", "missing.md", "SECRET.md"} {
		file, err := f.reader.ReadSource(ctx, f.owner.ID, 0, path)
		require.ErrorIs(t, err, ErrSourceNotFound, "path %q", path)
		require.Equal(t, SourceFile{}, file)
	}
	// The repository host's blob cap bounds a read; nothing is returned.
	file, err := f.reader.ReadSource(ctx, f.owner.ID, 0, "big.txt")
	require.ErrorIs(t, err, ErrSourceTooLarge)
	require.Equal(t, SourceFile{}, file)
}

func TestAgentSourceReadIsAuthorizedAsTheAskingMember(t *testing.T) {
	f := newMirrorReadFixture(t)
	f.ready()
	ctx := context.Background()
	// A stranger to the private mirror, an unknown account and a turn scoped
	// to another repository read nothing and are offered no source.
	for _, refused := range []struct {
		user, repository int64
	}{{f.stranger.ID, 0}, {f.owner.ID + 1000, 0}, {f.owner.ID, f.other}, {f.member.ID, f.other}} {
		_, err := f.reader.Source(ctx, refused.user, refused.repository)
		require.ErrorIs(t, err, ErrSourceForbidden)
		file, err := f.reader.ReadSource(ctx, refused.user, refused.repository, "JOURNEY.md")
		require.ErrorIs(t, err, ErrSourceForbidden)
		require.Equal(t, SourceFile{}, file)
	}
	// Losing access ends reads at once; the check runs per read.
	_, err := f.pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, f.mirror, f.member.ID)
	require.NoError(t, err)
	_, err = f.reader.ReadSource(ctx, f.member.ID, 0, "JOURNEY.md")
	require.ErrorIs(t, err, ErrSourceForbidden)
}
