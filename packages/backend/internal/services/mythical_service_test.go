package services

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// recordingRepoHost is a real bare repository behind repo-host's git surface.
// Like repo-host, its bookmark reads come from a separate jj view that a
// receive-pack updates by importing git refs; dropImports simulates a crash
// between the git update and that import, which only ImportRefs repairs.
type recordingRepoHost struct {
	*gitBackedRepoHost
	mu            sync.Mutex
	metas         []repohost.ReceivePackMetadata
	failBookmarks int
	dropImports   int
	heldPushes    int
	imports       int
	jj            []repohost.Bookmark
}

func (h *recordingRepoHost) importGitRefs() error {
	bookmarks, _, err := h.gitBackedRepoHost.ListBookmarks(context.Background(), "", "", "", 0)
	if err != nil {
		return err
	}
	h.jj = bookmarks
	return nil
}

func (h *recordingRepoHost) ProxyReceivePack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.metas = append(h.metas, meta...)
	if h.heldPushes > 0 {
		h.heldPushes--
		_, _ = io.Copy(io.Discard, stdin)
		return &repohost.StatusError{StatusCode: 503, Code: repohost.RepositoryHeldCode, RetryAfter: 5}
	}
	if err := h.gitBackedRepoHost.ProxyReceivePack(ctx, owner, repo, stdin, stdout, meta...); err != nil {
		return err
	}
	if h.dropImports > 0 {
		h.dropImports--
		return nil
	}
	return h.importGitRefs()
}

func (h *recordingRepoHost) ImportRefs(context.Context, string, string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.imports++
	return h.importGitRefs()
}

func (h *recordingRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.failBookmarks > 0 {
		h.failBookmarks--
		return nil, "", errors.New("repo-host unavailable")
	}
	return append([]repohost.Bookmark(nil), h.jj...), "", nil
}

type mythicalServiceFixture struct {
	*gitFixture
	host    *recordingRepoHost
	hostDir string
	service *MythicalService
	pool    MythicalStore
	repoID  int64
	userID  int64
}

func newMythicalServiceFixture(t *testing.T) *mythicalServiceFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	pool := newProductTestPool(t)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	hostDir := f.bare("host.git")
	host := &recordingRepoHost{gitBackedRepoHost: &gitBackedRepoHost{t: t, dir: hostDir}}
	ctx := context.Background()
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('smithers-canary', 'smithers-canary') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name, default_bookmark) VALUES ($1, 'smithers', 'smithers', 'main') RETURNING id`, userID).Scan(&repoID))
	service := NewMythicalService(pool, host)
	service.scratchRoot = filepath.Join(root, "scratch")
	return &mythicalServiceFixture{gitFixture: f, host: host, hostDir: hostDir, service: service, pool: pool, repoID: repoID, userID: userID}
}

// publish pushes the work repository's main to the host, as GitHub main
// arriving through the main pull would.
func (f *mythicalServiceFixture) publish() string {
	f.git(f.work, "push", "-q", "--force", f.hostDir, "main:refs/heads/main")
	require.NoError(f.t, f.host.ImportRefs(context.Background(), "", ""))
	return f.git(f.work, "rev-parse", "HEAD")
}

func (f *mythicalServiceFixture) hostRef(ref string) string {
	out, err := exec.Command("git", "--git-dir", f.hostDir, "rev-parse", "--verify", "--quiet", ref).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func (f *mythicalServiceFixture) hostTree(commit string) string {
	return f.git(f.hostDir, "rev-parse", commit+"^{tree}")
}

func (f *mythicalServiceFixture) poll() db.MythicalStack {
	f.t.Helper()
	require.NoError(f.t, f.service.PollOnce(context.Background()))
	row, err := db.New(f.pool).GetMythicalStack(context.Background(), f.repoID)
	require.NoError(f.t, err)
	return row
}

func TestMythicalServiceBootstrapsFoldsAndServesTheSnapshot(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	f.commit("✨ feat: two", "b.txt", "b")
	main := f.publish()

	absent, err := f.service.Snapshot(ctx, f.repoID, "smithers-canary/smithers", main, MythicalViewer{})
	require.NoError(t, err)
	assert.Equal(t, "absent", absent.State)

	_, err = f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	row := f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	tip := f.hostRef(repohost.MythicalBookmarkRef)
	require.NotEmpty(t, tip)
	assert.Equal(t, tip, row.TipCommit)
	assert.Equal(t, f.hostTree(main), f.hostTree(tip), "the stack's tree is main's")
	assert.Equal(t, main, row.LandedMain)
	assert.Equal(t, f.hostRef(repohost.MythicalNotesRef), row.NotesCommit)
	assert.NotEqual(t, main, tip, "the stack is its own history, never main's commits")
	for _, meta := range f.host.metas {
		assert.True(t, meta.ControlPlane, "every stack write is a control-plane push")
	}
	note := f.git(f.hostDir, "notes", "--ref=mythical", "show", tip)
	assert.Contains(t, note, "folded: "+main)

	// An outside commit reaches main; the stack folds it with exactly its tree.
	outside := f.commit("🔧 chore: outside", "c.txt", "c")
	f.publish()
	f.service.MainMoved(ctx, f.repoID)
	row = f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	assert.Equal(t, outside, row.LandedMain)
	folded := f.hostRef(repohost.MythicalBookmarkRef)
	assert.Equal(t, f.hostTree(outside), f.hostTree(folded))
	assert.Equal(t, tip, f.git(f.hostDir, "rev-parse", folded+"^"), "folds only append")
	assert.Equal(t, outside, f.hostRef("refs/heads/main"), "main is never written")

	view, err := f.service.Snapshot(ctx, f.repoID, "smithers-canary/smithers", outside, MythicalViewer{})
	require.NoError(t, err)
	assert.Equal(t, "active", view.State)
	assert.False(t, view.MainBehind)
	require.NotNil(t, view.Tip)
	assert.Equal(t, folded, view.Tip.CommitID)
	require.Len(t, view.Changes, 3)
	assert.Equal(t, "🔧 chore: outside", view.Changes[0].Title)
	assert.Equal(t, "fold", view.Changes[0].Kind)
	assert.Equal(t, "bootstrap", view.Changes[2].Kind)
	encoded, err := json.Marshal(view)
	require.NoError(t, err)
	assert.Contains(t, string(encoded), `"mainBehind":false`)
	assert.Len(t, view.Lanes, 2)

	// Nothing to do is a no-op run that writes nothing.
	f.service.MainMoved(ctx, f.repoID)
	again := f.poll()
	assert.Equal(t, folded, again.TipCommit)
	assert.Equal(t, row.Generation, again.Generation)
}

func TestMythicalServiceRecoversAPushItCouldNotConfirm(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	main := f.publish()
	_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)

	// The git refs land but repo-host crashes before its jj import: the
	// prepared write stays, and nothing is finalized.
	f.host.dropImports = 1
	row := f.poll()
	assert.Equal(t, "bootstrapping", row.State)
	require.NotEmpty(t, row.PendingOp)
	pushed := f.hostRef(repohost.MythicalBookmarkRef)
	require.NotEmpty(t, pushed)

	// A transient failure on the next claim keeps the prepared write too.
	f.host.failBookmarks = 1
	due := func() {
		_, err := f.pool.Exec(ctx, `UPDATE mythical_stacks SET next_attempt_at = NOW() WHERE repository_id = $1`, f.repoID)
		require.NoError(t, err)
	}
	due()
	row = f.poll()
	require.NotEmpty(t, row.PendingOp, "a failure never discards the evidence of a push")

	// The next claim sees the refs at the prepared values, asks repo-host to
	// import them, and finalizes without pushing again.
	pushes := len(f.host.metas)
	due()
	row = f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	assert.Empty(t, row.PendingOp)
	assert.Equal(t, pushed, row.TipCommit)
	assert.Equal(t, main, row.LandedMain)
	assert.Equal(t, pushes, len(f.host.metas), "recovery never pushes twice")
	assert.Equal(t, 2, f.host.imports, "the publish's import and one recovery import")
}

func TestMythicalServiceReplaysAPushThatNeverLanded(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	f.publish()
	_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	row := f.poll()
	require.Equal(t, "active", row.State, row.LastError)

	// A fold is prepared and persisted, then the worker dies before its push.
	f.commit("🔧 chore: outside", "b.txt", "b")
	outside := f.publish()
	var prepared mythicalOp
	func() {
		claims, err := db.New(f.pool).ClaimMythicalStacks(ctx, 1, 600)
		if err == nil && len(claims) == 0 {
			_, err = db.New(f.pool).RequestMythicalStack(ctx, f.repoID)
			require.NoError(t, err)
			claims, err = db.New(f.pool).ClaimMythicalStacks(ctx, 1, 600)
		}
		require.NoError(t, err)
		require.Len(t, claims, 1)
		g := mythicalGit{dir: filepath.Join(f.service.scratchRoot, "repo-"+strconv.FormatInt(f.repoID, 10)+".git")}
		bridge, err := startMythicalBridge(ctx, f.host, "smithers-canary", "smithers")
		require.NoError(t, err)
		defer bridge.Close()
		r := &mythicalRun{row: claims[0], g: g, bridge: bridge, owner: "smithers-canary", repo: "smithers", branch: "main",
			mainTip: outside, tip: row.TipCommit, notesRef: row.NotesCommit}
		require.NoError(t, g.fetch(ctx, bridge.URL(), 0, 0, repohost.MythicalBookmarkRef, repohost.MythicalNotesRef))
		require.NoError(t, f.service.connectMain(ctx, r, row.LandedMain))
		prepared = mythicalOp{Kind: "fold", OldTip: row.TipCommit, OldNotes: row.NotesCommit, From: 1, Folded: []string{outside}}
		require.NoError(t, f.service.compute(ctx, r, &prepared))
		encoded, err := json.Marshal(prepared)
		require.NoError(t, err)
		_, err = db.New(f.pool).SetMythicalPendingOp(ctx, f.repoID, claims[0].Claim, encoded)
		require.NoError(t, err)
		// The lease expires with the worker gone.
		_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at = NOW() - interval '1 second' WHERE repository_id = $1`, f.repoID)
		require.NoError(t, err)
	}()
	// The scratch repository is lost too; the replay rebuilds it.
	require.NoError(t, os.RemoveAll(f.service.scratchRoot))

	// Meanwhile main moves again: the replay still pushes the prepared fold,
	// never different work, and a later run folds the rest.
	f.commit("🔧 chore: later", "c.txt", "c")
	later := f.publish()
	// One poll settles the replay and then (a write asks for one more claim)
	// folds the rest on top of it.
	row = f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	assert.Equal(t, later, row.LandedMain)
	assert.Equal(t, prepared.NewTip, f.git(f.hostDir, "rev-parse", row.TipCommit+"^"), "the prepared fold landed exactly")
	assert.Equal(t, f.hostTree(later), f.hostTree(row.TipCommit))
}

func TestMythicalServiceFreezesWhenTheStackMovesOutsideIt(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	f.publish()
	_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	row := f.poll()
	require.Equal(t, "active", row.State, row.LastError)

	// Someone moves the bookmark directly on the host.
	f.git(f.hostDir, "update-ref", repohost.MythicalBookmarkRef, f.hostRef("refs/heads/main"))
	f.commit("✨ feat: two", "b.txt", "b")
	f.publish()
	f.service.MainMoved(ctx, f.repoID)
	row = f.poll()
	assert.Equal(t, "frozen", row.State)
	assert.Contains(t, row.Reason, "moved outside the stack service")

	// An admin reset rebuilds the stack from main and replaces the bookmark.
	_, err = f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, true)
	require.NoError(t, err)
	row = f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	assert.Zero(t, row.ResetGeneration)
	assert.Equal(t, f.hostTree(f.hostRef("refs/heads/main")), f.hostTree(f.hostRef(repohost.MythicalBookmarkRef)))
}

func TestMythicalServiceRefusesToOverwriteAnExistingBookmark(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	main := f.publish()
	f.git(f.hostDir, "update-ref", repohost.MythicalBookmarkRef, main)
	_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	row := f.poll()
	assert.Equal(t, "frozen", row.State)
	assert.Contains(t, row.Reason, "already exists")
	assert.Equal(t, main, f.hostRef(repohost.MythicalBookmarkRef))
}

// A stack push the repository's host refuses while holding the repository
// is not a failure: the pass is due again after the hold's Retry-After with
// no attempt spent and no error, and then it lands.
func TestMythicalServiceWaitsOutAHeldRepository(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	f.publish()
	_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	f.host.heldPushes = 1
	row := f.poll()
	require.NotEqual(t, "active", row.State)
	assert.Empty(t, row.LastError)
	assert.Zero(t, row.Attempts, "a held repository spent an attempt")
	assert.WithinDuration(t, time.Now().Add(5*time.Second), row.NextAttemptAt.Time, 3*time.Second)

	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET next_attempt_at = NOW() WHERE repository_id = $1`, f.repoID)
	require.NoError(t, err)
	row = f.poll()
	require.Equal(t, "active", row.State, row.LastError)
}
