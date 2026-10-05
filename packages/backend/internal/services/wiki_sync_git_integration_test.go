package services

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// wikiSyncGit runs git in dir as a user would, isolated from host config.
func wikiSyncGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=Vault", "-c", "user.email=vault@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"}, args...)...)
	cmd.Dir = dir
	for _, variable := range os.Environ() {
		if !strings.HasPrefix(variable, "GIT_") {
			cmd.Env = append(cmd.Env, variable)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	return strings.TrimSpace(string(out))
}

func latestWikiSyncEvents(t *testing.T, svc *WikiService, actor db.User, repo string) map[string]WikiEvent {
	t.Helper()
	events, err := svc.ListWikiEvents(context.Background(), &actor, actor.Username, repo, 0)
	require.NoError(t, err)
	latest := map[string]WikiEvent{}
	for _, event := range events {
		if !event.Deleted {
			latest[event.Path] = event
		}
	}
	return latest
}

// wikiSources returns each revision's recorded source commit from page history.
func wikiSources(t *testing.T, svc *WikiService, actor db.User, repo string, pageID int64) map[int64]string {
	t.Helper()
	history, _, err := svc.ListWikiPageHistory(context.Background(), &actor, actor.Username, repo, pageID, 1, 100)
	require.NoError(t, err)
	sources := map[int64]string{}
	for _, revision := range history {
		sources[revision.Revision] = revision.SourceCommit
	}
	return sources
}

func TestWikiSyncGitSourceCommitProvenance(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
	checkout := t.TempDir()
	wikiSyncGit(t, checkout, "init", "-q")
	vault := filepath.Join(checkout, "vault")
	require.NoError(t, os.MkdirAll(filepath.Join(vault, "assets"), 0700))
	markdown := "---\ntags: [ops]\n---\n# Home\n[[Other]]\n"
	image := []byte{0x89, 'P', 'N', 'G', 0, 1, 2, 3}
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Home.md"), []byte(markdown), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(vault, "assets", "logo.png"), image, 0600))
	require.NoError(t, os.WriteFile(filepath.Join(checkout, "outside.md"), []byte("# Outside\n"), 0600))
	wikiSyncGit(t, checkout, "add", ".")
	wikiSyncGit(t, checkout, "commit", "-q", "-m", "vault")
	first := wikiSyncGit(t, checkout, "rev-parse", "HEAD")
	// Untracked bytes in a checkout have no commit to attribute.
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Draft.md"), []byte("# Draft\n"), 0600))
	// Inherited repository overrides must not redirect discovery.
	other := t.TempDir()
	wikiSyncGit(t, other, "init", "-q")
	t.Setenv("GIT_DIR", filepath.Join(other, ".git"))
	t.Setenv("GIT_WORK_TREE", other)

	adapter, err := NewObsidianSync(vault)
	require.NoError(t, err)
	defer adapter.Close()
	run := func() {
		t.Helper()
		require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "git", adapter))
	}
	run()
	events := latestWikiSyncEvents(t, svc, actor, repo)
	require.Len(t, events, 3)
	home := events["Home.md"].PageID
	require.Equal(t, map[int64]string{1: first}, wikiSources(t, svc, actor, repo, home))
	require.Equal(t, map[int64]string{1: first}, wikiSources(t, svc, actor, repo, events["assets/logo.png"].PageID))
	require.Equal(t, map[int64]string{1: ""}, wikiSources(t, svc, actor, repo, events["Draft.md"].PageID))

	// An uncommitted edit is imported without provenance.
	edited := markdown + "local\n"
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Home.md"), []byte(edited), 0600))
	run()
	events = latestWikiSyncEvents(t, svc, actor, repo)
	require.Equal(t, map[int64]string{1: first, 2: ""}, wikiSources(t, svc, actor, repo, home))
	// Committing identical bytes adds no revision and rewrites no history.
	wikiSyncGit(t, checkout, "commit", "-q", "-am", "edit")
	run()
	events = latestWikiSyncEvents(t, svc, actor, repo)
	require.Equal(t, map[int64]string{1: first, 2: ""}, wikiSources(t, svc, actor, repo, home))

	// A committed rename records the commit holding the renamed path.
	wikiSyncGit(t, checkout, "mv", "vault/Home.md", "vault/Start.md")
	wikiSyncGit(t, checkout, "commit", "-q", "-m", "rename")
	renamed := wikiSyncGit(t, checkout, "rev-parse", "HEAD")
	run()
	events = latestWikiSyncEvents(t, svc, actor, repo)
	require.Equal(t, home, events["Start.md"].PageID)
	require.Equal(t, map[int64]string{1: first, 2: "", 3: renamed}, wikiSources(t, svc, actor, repo, home))

	// A wiki edit written out to the folder is not attributed to any commit.
	body := edited + "from wiki\n"
	page, err := svc.UpdateWikiPage(ctx, &actor, actor.Username, repo, events["Start.md"].Slug, UpdateWikiPageInput{Body: &body})
	require.NoError(t, err)
	run()
	written, err := os.ReadFile(filepath.Join(vault, "Start.md"))
	require.NoError(t, err)
	require.Equal(t, body, string(written))
	require.Equal(t, map[int64]string{1: first, 2: "", 3: renamed, page.Revision: ""}, wikiSources(t, svc, actor, repo, home))
}

func TestWikiSyncGitSourceCommitRefusals(t *testing.T) {
	ctx := context.Background()
	t.Run("folder outside a work tree", func(t *testing.T) {
		adapter, err := NewObsidianSync(t.TempDir())
		require.NoError(t, err)
		defer adapter.Close()
		commit, err := adapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
		require.NoError(t, err)
		require.Empty(t, commit)
	})
	t.Run("unborn head", func(t *testing.T) {
		checkout := t.TempDir()
		wikiSyncGit(t, checkout, "init", "-q")
		adapter, err := NewObsidianSync(checkout)
		require.NoError(t, err)
		defer adapter.Close()
		commit, err := adapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
		require.NoError(t, err)
		require.Empty(t, commit)
	})
	t.Run("bytes differ from the committed blob", func(t *testing.T) {
		checkout := t.TempDir()
		wikiSyncGit(t, checkout, "init", "-q")
		// Line-ending conversion makes the working bytes differ from the blob.
		require.NoError(t, os.WriteFile(filepath.Join(checkout, ".gitattributes"), []byte("*.md text eol=crlf\n"), 0600))
		require.NoError(t, os.WriteFile(filepath.Join(checkout, "Home.md"), []byte("# Home\n"), 0600))
		wikiSyncGit(t, checkout, "add", ".")
		wikiSyncGit(t, checkout, "commit", "-q", "-m", "crlf")
		require.NoError(t, os.Remove(filepath.Join(checkout, "Home.md")))
		wikiSyncGit(t, checkout, "checkout", "--", "Home.md")
		data, err := os.ReadFile(filepath.Join(checkout, "Home.md"))
		require.NoError(t, err)
		require.Equal(t, "# Home\r\n", string(data))
		adapter, err := NewObsidianSync(checkout)
		require.NoError(t, err)
		defer adapter.Close()
		commit, err := adapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, data)
		require.NoError(t, err)
		require.Empty(t, commit)
		commit, err = adapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
		require.NoError(t, err)
		require.Equal(t, wikiSyncGit(t, checkout, "rev-parse", "HEAD"), commit)
	})
	t.Run("replacement objects are ignored", func(t *testing.T) {
		checkout := t.TempDir()
		wikiSyncGit(t, checkout, "init", "-q")
		require.NoError(t, os.WriteFile(filepath.Join(checkout, "Home.md"), []byte("# Home\n"), 0600))
		wikiSyncGit(t, checkout, "add", ".")
		wikiSyncGit(t, checkout, "commit", "-q", "-m", "home")
		head := wikiSyncGit(t, checkout, "rev-parse", "HEAD")
		// Replace HEAD with a commit whose tree holds other bytes.
		require.NoError(t, os.WriteFile(filepath.Join(checkout, "Home.md"), []byte("# Forged\n"), 0600))
		wikiSyncGit(t, checkout, "commit", "-q", "-am", "forged")
		forged := wikiSyncGit(t, checkout, "rev-parse", "HEAD")
		wikiSyncGit(t, checkout, "reset", "-q", "--hard", head)
		wikiSyncGit(t, checkout, "replace", head, forged)
		require.Equal(t, "# Forged", wikiSyncGit(t, checkout, "show", "HEAD:Home.md"))
		adapter, err := NewObsidianSync(checkout)
		require.NoError(t, err)
		defer adapter.Close()
		commit, err := adapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Forged\n"))
		require.NoError(t, err)
		require.Empty(t, commit)
		commit, err = adapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
		require.NoError(t, err)
		require.Equal(t, head, commit)
	})
	t.Run("invalid path", func(t *testing.T) {
		adapter, err := NewObsidianSync(t.TempDir())
		require.NoError(t, err)
		defer adapter.Close()
		for _, name := range []string{"../escape.md", ".git/config", "/abs.md"} {
			_, err = adapter.SourceCommit(ctx, SyncDocument{Path: name}, nil)
			require.Error(t, err, name)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		checkout := t.TempDir()
		wikiSyncGit(t, checkout, "init", "-q")
		require.NoError(t, os.WriteFile(filepath.Join(checkout, "Home.md"), []byte("# Home\n"), 0600))
		wikiSyncGit(t, checkout, "add", ".")
		wikiSyncGit(t, checkout, "commit", "-q", "-m", "home")
		adapter, err := NewObsidianSync(checkout)
		require.NoError(t, err)
		defer adapter.Close()
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		_, err = adapter.SourceCommit(cancelled, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
		require.ErrorIs(t, err, context.Canceled)
	})
}

func TestWikiRevisionSourceRecordGuards(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
	page, err := svc.CreateWikiPage(ctx, &actor, actor.Username, repo, CreateWikiPageInput{Title: "Home", Body: "# Home\n"})
	require.NoError(t, err)
	event := WikiEvent{PageID: page.ID, Revision: page.Revision}
	commit := strings.Repeat("a", 40)
	require.Error(t, svc.recordWikiSyncSource(ctx, &actor, actor.Username, repo, event, "HEAD"))
	// Another author's revision is never annotated.
	other := actor
	other.ID++
	require.NoError(t, svc.recordWikiSyncSource(ctx, &other, actor.Username, repo, event, commit))
	require.Equal(t, map[int64]string{1: ""}, wikiSources(t, svc, actor, repo, page.ID))
	require.NoError(t, svc.recordWikiSyncSource(ctx, &actor, actor.Username, repo, event, commit))
	require.Equal(t, map[int64]string{1: commit}, wikiSources(t, svc, actor, repo, page.ID))
	// Provenance is written once, and the sequenced event stays as authored.
	require.NoError(t, svc.recordWikiSyncSource(ctx, &actor, actor.Username, repo, event, strings.Repeat("b", 64)))
	require.Equal(t, map[int64]string{1: commit}, wikiSources(t, svc, actor, repo, page.ID))
	events, err := svc.ListWikiEvents(ctx, &actor, actor.Username, repo, 0)
	require.NoError(t, err)
	encoded, err := json.Marshal(events)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "source_commit")
	// Storage refuses rewriting a receipt, other fields, and malformed commits.
	_, err = pool.Exec(ctx, `UPDATE wiki_page_revisions SET source_commit=$2 WHERE page_id=$1`, page.ID, strings.Repeat("b", 40))
	require.ErrorContains(t, err, "wiki revisions are immutable")
	_, err = pool.Exec(ctx, `UPDATE wiki_page_revisions SET body='rewritten' WHERE page_id=$1`, page.ID)
	require.ErrorContains(t, err, "wiki revisions are immutable")
	second, err := svc.UpdateWikiPage(ctx, &actor, actor.Username, repo, page.Slug, UpdateWikiPageInput{Body: new("# Home\nmore\n")})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE wiki_page_revisions SET source_commit='not-a-commit' WHERE page_id=$1 AND revision=$2`, page.ID, second.Revision)
	require.ErrorContains(t, err, "check constraint")
	require.Equal(t, map[int64]string{1: commit, 2: ""}, wikiSources(t, svc, actor, repo, page.ID))
}

// wrapGit makes the backend's git one that runs action when an argument
// equals trigger and the real git otherwise, so plumbing failures are
// observable.
func wrapGit(t *testing.T, trigger, action string) {
	t.Helper()
	real, err := exec.LookPath("git")
	require.NoError(t, err)
	bin := t.TempDir()
	script := "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = " + trigger + " ] && { " + action + "; }; done\nexec " + real + " \"$@\"\n"
	require.NoError(t, os.WriteFile(filepath.Join(bin, "git"), []byte(script), 0700))
	useGitProgram(t, filepath.Join(bin, "git"), "")
}

// useGitProgram makes program the git every backend git run starts, with
// helpers from execPath when it is set, for the test (hostexec's Go option;
// never PATH).
func useGitProgram(t *testing.T, program, execPath string) {
	t.Helper()
	restore, err := hostexec.Configure(hostexec.Config{Git: program, GitExecPath: execPath, Environment: hostexec.Environment()})
	require.NoError(t, err)
	t.Cleanup(restore)
}

func TestWikiSyncGitSourceCommitFailures(t *testing.T) {
	ctx := context.Background()
	checkout := t.TempDir()
	wikiSyncGit(t, checkout, "init", "-q")
	require.NoError(t, os.WriteFile(filepath.Join(checkout, "Home.md"), []byte("# Home\n"), 0600))
	wikiSyncGit(t, checkout, "add", ".")
	wikiSyncGit(t, checkout, "commit", "-q", "-m", "home")
	adapter, err := NewObsidianSync(checkout)
	require.NoError(t, err)
	defer adapter.Close()
	t.Run("no git on the host", func(t *testing.T) {
		useGitProgram(t, filepath.Join(t.TempDir(), "git"), "")
		commit, err := adapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
		require.NoError(t, err)
		require.Empty(t, commit)
	})
	head := wikiSyncGit(t, checkout, "rev-parse", "HEAD")
	for _, trigger := range []string{"HEAD^{commit}", head + ":Home.md"} {
		t.Run("lookup failure is not missing provenance "+trigger, func(t *testing.T) {
			wrapGit(t, "'"+trigger+"'", "echo broken >&2; exit 128")
			_, err := adapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
			var exit *exec.ExitError
			require.ErrorAs(t, err, &exit)
			require.Equal(t, 128, exit.ExitCode())
		})
	}
	// A descendant keeps the pipes open for 30 s; cancellation must not wait for it.
	for _, trigger := range []string{"--show-prefix", "HEAD^{commit}", head + ":Home.md", "hash-object"} {
		t.Run("cancelled during "+trigger, func(t *testing.T) {
			wrapGit(t, "'"+trigger+"'", "/bin/sleep 30; exit 1")
			deadline, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			started := time.Now()
			_, err := adapter.SourceCommit(deadline, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
			require.ErrorIs(t, err, context.DeadlineExceeded)
			require.Less(t, time.Since(started), 10*time.Second)
		})
	}
	t.Run("broken repository configuration", func(t *testing.T) {
		broken := t.TempDir()
		wikiSyncGit(t, broken, "init", "-q")
		require.NoError(t, os.WriteFile(filepath.Join(broken, ".git", "config"), []byte("[core\n"), 0600))
		brokenAdapter, err := NewObsidianSync(broken)
		require.NoError(t, err)
		defer brokenAdapter.Close()
		_, err = brokenAdapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
		var exit *exec.ExitError
		require.ErrorAs(t, err, &exit)
		require.Contains(t, string(exit.Stderr), "bad config")
	})
	t.Run("folder removed", func(t *testing.T) {
		gone := filepath.Join(t.TempDir(), "vault")
		require.NoError(t, os.Mkdir(gone, 0700))
		removed, err := NewObsidianSync(gone)
		require.NoError(t, err)
		defer removed.Close()
		require.NoError(t, os.Remove(gone))
		_, err = removed.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
		require.ErrorIs(t, err, os.ErrNotExist)
	})
	t.Run("plumbing failure fails the import", func(t *testing.T) {
		wrapGit(t, "hash-object", "echo broken >&2; exit 3")
		_, err := adapter.SourceCommit(ctx, SyncDocument{Path: "Home.md"}, []byte("# Home\n"))
		var exit *exec.ExitError
		require.ErrorAs(t, err, &exit)
		pool := newProductTestPool(t)
		actor, repo := issueCovSeedUserRepo(t, pool)
		q := db.New(pool)
		svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
		require.ErrorAs(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "git", adapter), &exit)
		pages, _, err := svc.ListWikiPages(ctx, &actor, actor.Username, repo, ListWikiPagesInput{})
		require.NoError(t, err)
		require.Empty(t, pages)
	})
}

func TestWikiRevisionSourceRecordUnavailable(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 1, Username: "alice"}
	commit := strings.Repeat("a", 40)
	err := newTestWikiService(&mockWikiQuerier{}, nil).recordWikiSyncSource(ctx, actor, "alice", "demo", WikiEvent{PageID: 1, Revision: 1}, commit)
	require.ErrorContains(t, err, "provenance is unavailable")
	pool := newProductTestPool(t)
	q := db.New(pool)
	err = newTestWikiService(q, nil).recordWikiSyncSource(ctx, actor, "nobody", "missing", WikiEvent{PageID: 1, Revision: 1}, commit)
	require.Error(t, err)
}
