package externalsessions

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const (
	id    = "0199aaaa-1111-7222-8333-444455556666"
	other = "0199bbbb-1111-7222-8333-444455556666"
	claud = "5b2c9e10-4d3a-4f6e-9a1b-7c8d9e0f1a2b"
)

func write(t *testing.T, path, content string, modified time.Time) string {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o600))
	require.NoError(t, os.Chtimes(path, modified, modified))
	return path
}

func rollout(root, session string) string {
	return filepath.Join(root, "2026", "10", "05", "rollout-2026-10-05T11-45-26-"+session+".jsonl")
}

func refusal(t *testing.T, err error) *Refusal {
	t.Helper()
	var refused *Refusal
	require.True(t, errors.As(err, &refused), "want a refusal, got %v", err)
	return refused
}

func TestRootsAreEachAgentsOwnHomesOnly(t *testing.T) {
	home := t.TempDir()
	for _, account := range []string{"codex-2", "claude-1", "claude-acct-3", "gemini"} {
		require.NoError(t, os.MkdirAll(filepath.Join(home, ".smithers", "accounts", account), 0o700))
	}
	// A file named like an account is not a home.
	write(t, filepath.Join(home, ".smithers", "accounts", "codex-file"), "", time.Now())
	env := map[string]string{"CODEX_HOME": "/custom/codex", "CLAUDE_CONFIG_DIR": "/custom/claude"}
	finder := &Finder{Home: home, Getenv: func(name string) string { return env[name] }}
	require.Equal(t, []string{"/custom/codex/sessions", filepath.Join(home, ".codex", "sessions"), filepath.Join(home, ".smithers", "accounts", "codex-2", "sessions")}, finder.Roots(Codex))
	require.Equal(t, []string{"/custom/claude/projects", filepath.Join(home, ".claude", "projects"),
		filepath.Join(home, ".smithers", "accounts", "claude-1", "projects"), filepath.Join(home, ".smithers", "accounts", "claude-acct-3", "projects")}, finder.Roots(ClaudeCode))
	// The configured home that is the default home is listed once; no home lists only the configured one.
	env["CODEX_HOME"] = filepath.Join(home, ".codex")
	require.Equal(t, []string{filepath.Join(home, ".codex", "sessions"), filepath.Join(home, ".smithers", "accounts", "codex-2", "sessions")}, finder.Roots(Codex))
	require.Equal(t, []string{"/custom/claude/projects"}, (&Finder{Getenv: func(name string) string { return env[name] }}).Roots(ClaudeCode))
	require.Empty(t, (&Finder{}).Roots(Codex))
}

func TestFindReadsTheNewestCopyAndRefusesUnknownOrAmbiguous(t *testing.T) {
	home := t.TempDir()
	old := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	write(t, rollout(filepath.Join(home, ".codex", "sessions"), id), "stale\n", old)
	live := write(t, rollout(filepath.Join(home, ".smithers", "accounts", "codex-2", "sessions"), id), "live\n", old.Add(time.Hour))
	write(t, rollout(filepath.Join(home, ".smithers", "accounts", "codex-2", "sessions"), other), "other\n", old)
	// Neither another agent's file nor a file that is not a rollout is a Codex session.
	write(t, filepath.Join(home, ".codex", "sessions", "2026", "notes-"+id+".jsonl"), "", old)
	write(t, filepath.Join(home, ".claude", "projects", "-repo", id+".jsonl"), "", old)
	finder := &Finder{Home: home}

	for _, prefix := range []string{id, "0199aaaa"} {
		found, err := finder.Find(Codex, prefix)
		require.NoError(t, err)
		require.Equal(t, Session{Agent: Codex, ID: id, Path: live}, found)
	}
	_, err := finder.Find(Codex, "ffff")
	require.Equal(t, &Refusal{http.StatusNotFound, "source_not_found", "No Codex session ffff on this machine."}, refusal(t, err))
	_, err = finder.Find(Codex, "0199")
	require.Equal(t, &Refusal{http.StatusConflict, "ambiguous_session", "0199 matches 2 Codex sessions: " + id + ", " + other + "."}, refusal(t, err))
	for _, bad := range []string{"", "019", "../etc", "0199AAAA", strings.Repeat("a", 37), "0199/aaaa"} {
		_, err = finder.Find(Codex, bad)
		require.Equal(t, http.StatusBadRequest, refusal(t, err).Status, bad)
	}
}

func TestFindClaudeCodeSessionsInProjectDirectories(t *testing.T) {
	home := t.TempDir()
	old := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	write(t, filepath.Join(home, ".claude", "projects", "-Users-ben-repo", claud+".jsonl"), "stale\n", old)
	live := write(t, filepath.Join(home, ".smithers", "accounts", "claude-2", "projects", "-Users-ben-repo", claud+".jsonl"), "live\n", old.Add(time.Minute))
	// A subagent's transcript under the session's directory is not the session; a Codex rollout is not Claude Code's.
	write(t, filepath.Join(home, ".claude", "projects", "-Users-ben-repo", claud, "subagents", "agent-"+claud+".jsonl"), "", old)
	write(t, rollout(filepath.Join(home, ".codex", "sessions"), "5b2c0000-0000-0000-0000-000000000000"), "", old)
	finder := &Finder{Home: home}
	found, err := finder.Find(ClaudeCode, "5b2c")
	require.NoError(t, err)
	require.Equal(t, Session{Agent: ClaudeCode, ID: claud, Path: live}, found)
	_, err = finder.Find(ClaudeCode, "0199")
	require.Equal(t, "No Claude Code session 0199 on this machine.", refusal(t, err).Message)
}

func TestFindFollowsALinkedRootButNoLinkUnderIt(t *testing.T) {
	home, outside, elsewhere := t.TempDir(), t.TempDir(), t.TempDir()
	// A home kept elsewhere and linked in is the agent's home.
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".codex"), 0o700))
	require.NoError(t, os.Symlink(outside, filepath.Join(home, ".codex", "sessions")))
	kept := write(t, rollout(outside, id), "kept\n", time.Now())
	finder := &Finder{Home: home}
	found, err := finder.Find(Codex, id)
	require.NoError(t, err)
	require.Equal(t, Session{Agent: Codex, ID: id, Path: rollout(filepath.Join(home, ".codex", "sessions"), id)}, found)
	require.Equal(t, filepath.Base(kept), filepath.Base(found.Path))
	// A linked file or directory inside a home is not a session.
	write(t, rollout(elsewhere, other), "secret\n", time.Now())
	require.NoError(t, os.Symlink(filepath.Join(elsewhere, "2026"), filepath.Join(outside, "linked")))
	_, err = finder.Find(Codex, other)
	require.Equal(t, http.StatusNotFound, refusal(t, err).Status)
	target := write(t, filepath.Join(elsewhere, "secret.jsonl"), "secret\n", time.Now())
	project := filepath.Join(home, ".claude", "projects", "-repo")
	require.NoError(t, os.MkdirAll(project, 0o700))
	require.NoError(t, os.Symlink(target, filepath.Join(project, claud+".jsonl")))
	_, err = finder.Find(ClaudeCode, claud)
	require.Equal(t, http.StatusNotFound, refusal(t, err).Status)
}

func TestReadAnswersCompleteLinesFromAnOffset(t *testing.T) {
	path := write(t, filepath.Join(t.TempDir(), "s.jsonl"), "one\ntwo · naïve\nthr", time.Now())
	chunk, err := Read(path, 0)
	require.NoError(t, err)
	require.Equal(t, Chunk{Offset: 0, Next: 18, Text: []byte("one\ntwo · naïve\n"), EOF: true}, chunk)
	// The incomplete line waits; once it ends, the next read starts at it.
	chunk, err = Read(path, 18)
	require.NoError(t, err)
	require.Equal(t, Chunk{Offset: 18, Next: 18, Text: []byte{}, EOF: true}, chunk)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	require.NoError(t, err)
	_, err = file.WriteString("ee\n")
	require.NoError(t, err)
	require.NoError(t, file.Close())
	chunk, err = Read(path, 18)
	require.NoError(t, err)
	require.Equal(t, Chunk{Offset: 18, Next: 24, Text: []byte("three\n"), EOF: true}, chunk)
	chunk, err = Read(path, 24)
	require.NoError(t, err)
	require.Equal(t, Chunk{Offset: 24, Next: 24, Text: []byte{}, EOF: true}, chunk)
	// A file shorter than the offset was replaced; a missing one is gone.
	_, err = Read(path, 25)
	require.Equal(t, &Refusal{http.StatusConflict, "offset_out_of_range", "The session file is 24 bytes, shorter than offset 25: it was replaced."}, refusal(t, err))
	_, err = Read(filepath.Join(filepath.Dir(path), "gone.jsonl"), 0)
	require.Equal(t, http.StatusNotFound, refusal(t, err).Status)
	// A file swapped for a link after it was found is not followed.
	linked := filepath.Join(filepath.Dir(path), "linked.jsonl")
	require.NoError(t, os.Symlink(path, linked))
	_, err = Read(linked, 0)
	require.Equal(t, http.StatusNotFound, refusal(t, err).Status)
}

func TestReadCapsAChunkAtALineBoundary(t *testing.T) {
	line := strings.Repeat("x", 1<<20-1) + "\n" // 1 MiB a line
	path := write(t, filepath.Join(t.TempDir(), "s.jsonl"), strings.Repeat(line, 9), time.Now())
	var offset int64
	var sizes []int
	for {
		chunk, err := Read(path, offset)
		require.NoError(t, err)
		require.True(t, strings.HasSuffix(string(chunk.Text), "\n"))
		require.LessOrEqual(t, len(chunk.Text), ChunkLimit)
		require.Equal(t, offset+int64(len(chunk.Text)), chunk.Next)
		sizes = append(sizes, len(chunk.Text)>>20)
		offset = chunk.Next
		if chunk.EOF {
			break
		}
	}
	require.Equal(t, []int{4, 4, 1}, sizes)
	require.Equal(t, int64(9<<20), offset)
}

func TestReadReturnsALineLongerThanAChunkAloneUpToTheLineLimit(t *testing.T) {
	long := strings.Repeat("y", ChunkLimit+10) + "\n"
	path := write(t, filepath.Join(t.TempDir(), "s.jsonl"), long+"short\n", time.Now())
	chunk, err := Read(path, 0)
	require.NoError(t, err)
	require.Equal(t, long, string(chunk.Text))
	require.False(t, chunk.EOF)
	chunk, err = Read(path, chunk.Next)
	require.NoError(t, err)
	require.Equal(t, "short\n", string(chunk.Text))
	require.True(t, chunk.EOF)

	// Still being written: nothing yet, not a refusal.
	writing := write(t, filepath.Join(t.TempDir(), "w.jsonl"), strings.Repeat("z", ChunkLimit+10), time.Now())
	chunk, err = Read(writing, 0)
	require.NoError(t, err)
	require.Equal(t, Chunk{Offset: 0, Next: 0, Text: []byte{}, EOF: true}, chunk)

	huge := write(t, filepath.Join(t.TempDir(), "h.jsonl"), strings.Repeat("h", LineLimit+1)+"\n", time.Now())
	_, err = Read(huge, 0)
	require.Equal(t, &Refusal{http.StatusUnprocessableEntity, "line_too_long", "The line at byte 0 is longer than 64 MiB."}, refusal(t, err))
}

func TestParseAgent(t *testing.T) {
	for value, want := range map[string]Agent{"codex": Codex, "claude-code": ClaudeCode} {
		agent, ok := ParseAgent(value)
		require.True(t, ok)
		require.Equal(t, want, agent)
	}
	for _, value := range []string{"", "claude", "Codex", "gemini"} {
		_, ok := ParseAgent(value)
		require.False(t, ok, value)
	}
	require.Equal(t, "Claude Code", ClaudeCode.Name())
	require.Equal(t, "Codex", Codex.Name())
}

func TestFindRemembersAFoundSessionWhileItsFileIsThere(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".codex", "sessions")
	old := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	first := write(t, rollout(root, id), "first\n", old)
	clock := old
	finder := &Finder{Home: home, Remember: 10 * time.Second, Now: func() time.Time { return clock }}
	_, err := finder.Find(Codex, "0199aaaa")
	require.NoError(t, err)
	// A newer copy within the window is not looked for; after it, it wins.
	second := write(t, rollout(filepath.Join(home, ".smithers", "accounts", "codex-1", "sessions"), id), "second\n", old.Add(time.Hour))
	found, err := finder.Find(Codex, "0199aaaa")
	require.NoError(t, err)
	require.Equal(t, first, found.Path)
	clock = clock.Add(10 * time.Second)
	found, err = finder.Find(Codex, "0199aaaa")
	require.NoError(t, err)
	require.Equal(t, second, found.Path)
	// A remembered file that is gone is looked for again at once.
	require.NoError(t, os.Remove(second))
	found, err = finder.Find(Codex, "0199aaaa")
	require.NoError(t, err)
	require.Equal(t, first, found.Path)
	// Refusals are not remembered: a session that appears is found on the next call.
	_, err = finder.Find(Codex, "0199bbbb")
	require.Error(t, err)
	write(t, rollout(root, other), "other\n", old)
	found, err = finder.Find(Codex, "0199bbbb")
	require.NoError(t, err)
	require.Equal(t, other, found.ID)
}
