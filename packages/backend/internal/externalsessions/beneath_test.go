package externalsessions

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"
)

// opens runs f once with openat2 (where the kernel has it) and once with the
// per-component openat chain.
func opens(t *testing.T, f func(t *testing.T)) {
	for name, openat2 := range map[string]bool{"openat2": true, "openat chain": false} {
		t.Run(name, func(t *testing.T) {
			previous := useOpenat2
			useOpenat2 = openat2
			t.Cleanup(func() { useOpenat2 = previous })
			f(t)
		})
	}
}

// swap moves the directory dir out of its root and puts a link to target
// in its place, as anything running as the account could between Find and
// Read.
func swap(t *testing.T, dir, target string) {
	t.Helper()
	require.NoError(t, os.Rename(dir, filepath.Join(t.TempDir(), "moved")))
	require.NoError(t, os.Symlink(target, dir))
}

var gone = &Refusal{Status: http.StatusNotFound, Class: "user", Code: "source_not_found", Message: "The session file is gone."}

func TestReadRefusesADirectorySwappedForALinkAfterFind(t *testing.T) {
	opens(t, func(t *testing.T) {
		home := t.TempDir()
		accounts := filepath.Join(home, ".smithers", "accounts")
		// Codex: the dated directory becomes a link into another account's
		// home, which holds a rollout at the same relative path.
		root := filepath.Join(home, ".codex", "sessions")
		write(t, rollout(root, id), "mine\n", time.Now())
		write(t, rollout(filepath.Join(accounts, "codex-2", "sessions"), id), "other account\n", time.Now())
		// Claude Code: the project directory becomes a link the same way.
		project := filepath.Join(home, ".claude", "projects", "-Users-ben-repo")
		write(t, filepath.Join(project, claud+".jsonl"), "mine\n", time.Now())
		write(t, filepath.Join(accounts, "claude-1", "projects", "-Users-ben-repo", claud+".jsonl"), "other account\n", time.Now())
		finder := &Finder{Home: home}

		codex, err := finder.Find(Codex, id)
		require.NoError(t, err)
		claude, err := finder.Find(ClaudeCode, claud)
		require.NoError(t, err)
		swap(t, filepath.Join(root, "2026", "10"), filepath.Join(accounts, "codex-2", "sessions", "2026", "10"))
		swap(t, project, filepath.Join(accounts, "claude-1", "projects", "-Users-ben-repo"))

		for _, session := range []Session{codex, claude} {
			chunk, err := Read(session, 0)
			require.Equal(t, gone, refusal(t, err), session.Agent)
			require.Empty(t, chunk.Text)
			_, err = session.Size()
			require.Equal(t, gone, refusal(t, err), session.Agent)
		}
		// The other account's files are not found either.
		for agent, prefix := range map[Agent]string{Codex: id, ClaudeCode: claud} {
			_, err = finder.Find(agent, prefix)
			require.Equal(t, http.StatusNotFound, refusal(t, err).Status, agent)
		}
	})
}

func TestFindRefusesARememberedSessionWhoseParentBecameALink(t *testing.T) {
	opens(t, func(t *testing.T) {
		home := t.TempDir()
		root := filepath.Join(home, ".codex", "sessions")
		write(t, rollout(root, id), "mine\n", time.Now())
		other := filepath.Join(home, ".smithers", "accounts", "codex-2", "sessions")
		write(t, rollout(other, id), "other account\n", time.Now())
		clock := time.Now()
		finder := &Finder{Home: home, Remember: time.Hour, Now: func() time.Time { return clock }}
		_, err := finder.Find(Codex, id)
		require.NoError(t, err)
		// The remembered file's own directory is now a link: the hit is not
		// served, and the fresh look finds nothing beneath the root.
		swap(t, filepath.Join(root, "2026", "10", "05"), filepath.Join(other, "2026", "10", "05"))
		_, err = finder.Find(Codex, id)
		require.Equal(t, http.StatusNotFound, refusal(t, err).Status)
	})
}

func TestARootIsALinkOnlyIntoTheAccountsOwnHome(t *testing.T) {
	home, elsewhere := t.TempDir(), t.TempDir()
	link := func(target string) {
		t.Helper()
		sessions := filepath.Join(home, ".codex", "sessions")
		require.NoError(t, os.MkdirAll(filepath.Dir(sessions), 0o700))
		_ = os.Remove(sessions)
		require.NoError(t, os.Symlink(target, sessions))
	}
	dotfiles := filepath.Join(home, "dotfiles", "codex", "sessions")
	account := filepath.Join(home, ".smithers", "accounts", "codex-2", "sessions")
	for _, dir := range []string{dotfiles, elsewhere, account} {
		write(t, rollout(dir, id), dir+"\n", time.Now())
	}
	clock := time.Now()
	finder := &Finder{Home: home, Remember: time.Hour, Now: func() time.Time { return clock }}

	// A dotfiles directory inside the home is the agent's home.
	link(dotfiles)
	found, err := finder.Find(Codex, id)
	require.NoError(t, err)
	chunk, err := Read(found, 0)
	require.NoError(t, err)
	require.Equal(t, dotfiles+"\n", string(chunk.Text))

	// Outside the home, or into another account's home, the root yields no
	// session, and the link is resolved again even for a remembered one.
	for _, target := range []string{elsewhere, account} {
		link(target)
		_, err = finder.Find(Codex, id)
		require.Equal(t, http.StatusNotFound, refusal(t, err).Status, target)
		_, err = Read(found, 0)
		require.NoError(t, err, "a session already found still reads beneath its own real root")
	}

	// A home that is itself reached through a link (macOS /var, say) is
	// resolved first; a configured home is no link and may be anywhere.
	linkedHome := filepath.Join(t.TempDir(), "home")
	require.NoError(t, os.Symlink(home, linkedHome))
	link(dotfiles)
	_, err = (&Finder{Home: linkedHome}).Find(Codex, id)
	require.NoError(t, err)
	configured := filepath.Join(t.TempDir(), "codex")
	write(t, rollout(filepath.Join(configured, "sessions"), other), "configured\n", time.Now())
	_, err = (&Finder{Getenv: func(name string) string { return map[string]string{"CODEX_HOME": configured}[name] }}).Find(Codex, other)
	require.NoError(t, err)
	// A configured home that is a link out of the home is refused.
	linkedConfigured := filepath.Join(home, "codex-link")
	require.NoError(t, os.Symlink(configured, linkedConfigured))
	_, err = (&Finder{Home: home, Getenv: func(name string) string { return map[string]string{"CODEX_HOME": linkedConfigured}[name] }}).Find(Codex, other)
	require.Equal(t, http.StatusNotFound, refusal(t, err).Status)
}

func TestReadFailuresAreTypedRefusals(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a file of mode 000")
	}
	opens(t, func(t *testing.T) {
		path := write(t, filepath.Join(t.TempDir(), "s.jsonl"), "one\n", time.Now())
		require.NoError(t, os.Chmod(path, 0))
		t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
		_, err := Read(at(path), 0)
		unreadable := &Refusal{Status: http.StatusServiceUnavailable, Class: "infra", Code: "source_unreadable", Message: "The session file could not be read."}
		require.Equal(t, unreadable, refusal(t, err))
		_, err = at(path).Size()
		require.Equal(t, unreadable, refusal(t, err))
		// A directory or a FIFO where the file was is gone, and the open
		// does not block on the FIFO.
		dir := filepath.Join(t.TempDir(), "d.jsonl")
		require.NoError(t, os.Mkdir(dir, 0o700))
		_, err = Read(at(dir), 0)
		require.Equal(t, gone, refusal(t, err))
		fifo := filepath.Join(t.TempDir(), "f.jsonl")
		require.NoError(t, unix.Mkfifo(fifo, 0o600))
		_, err = Read(at(fifo), 0)
		require.Equal(t, gone, refusal(t, err))
		_, err = Read(Session{}, 0)
		require.Equal(t, gone, refusal(t, err))
		_, err = Read(Session{root: filepath.Dir(path), rel: "../" + filepath.Base(path)}, 0)
		require.Equal(t, gone, refusal(t, err))
	})
}
