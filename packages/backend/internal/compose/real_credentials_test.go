package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Personal-subscription fixtures are inert sentinel bytes, never live logins.
// API-key tools are separately covered by the M-42 secret-file check.
func testInstalledCredentials(t *testing.T, h *rootLayerHarness, branch string, term *rehearsalTerminal, browser, aliceBrowser http.CookieJar) {
	t.Helper()
	installedShell(t, term, `mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.config/gh" && printf 'mch-claude-A-fixture\n' > "$HOME/.claude/.credentials.json" && printf 'mch-codex-A-fixture\n' > "$HOME/.codex/auth.json" && printf 'mch-gh-A-fixture\n' > "$HOME/.config/gh/hosts.yml" && printf 'mch-marker-A-fixture\n' > "$HOME/.marker" && test "$(stat -c %a "$HOME/.marker")" = 664`)
	var todo struct {
		N int64 `json:"n"`
	}
	code, body := h.request("POST", "/api/todos", `{"title":"Credential isolation","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, uuid.NewString())
	require.Equal(t, 202, code, string(body))
	require.NoError(t, json.Unmarshal(body, &todo))
	var secondBranch string
	require.Eventually(t, func() bool {
		return h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=$1`, todo.N).Scan(&secondBranch) == nil && secondBranch != "" && secondBranch != branch
	}, 15*time.Minute, 250*time.Millisecond)
	second := installedMemberTerminal(t, h, secondBranch, browser)
	installedShell(t, second, `test ! -e "$HOME/.marker" && test ! -e "$HOME/.claude/.credentials.json" && test ! -e "$HOME/.codex/auth.json" && test ! -e "$HOME/.config/gh/hosts.yml" && mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.config/gh" && printf 'mch-claude-B-fixture\n' > "$HOME/.claude/.credentials.json" && printf 'mch-codex-B-fixture\n' > "$HOME/.codex/auth.json" && printf 'mch-gh-B-fixture\n' > "$HOME/.config/gh/hosts.yml"`)
	installedShell(t, term, `test "$(cat "$HOME/.claude/.credentials.json")" = mch-claude-A-fixture && test "$(cat "$HOME/.codex/auth.json")" = mch-codex-A-fixture && test "$(cat "$HOME/.config/gh/hosts.yml")" = mch-gh-A-fixture && test "$(stat -c '%u:%g:%a' "$HOME")" = 20001:20001:700`)
	testInstalledHomeWorkload(t, term, second)
	// Every fixture login is private, including files below tool-specific parents.
	alice := installedMemberTerminal(t, h, branch, aliceBrowser)
	installedShell(t, alice, installedBenHomeDenied)
	alice.close()
	result, err := h.runtime.ExecuteCommand(t.Context(), branch, workspaceapi.Command{Args: []string{"/bin/sh", "-c", installedBenHomeDenied}})
	require.NoError(t, err)
	require.Zero(t, result.ExitCode, result.Stdout+result.Stderr)

	for _, entry := range []struct {
		id, tag string
		term    *rehearsalTerminal
	}{{branch, "A", term}, {secondBranch, "B", second}} {
		entry.term.close()
		code, body := h.request("POST", "/api/branches/"+entry.id, `{"op":"sleep"}`, uuid.NewString())
		require.Equal(t, 202, code, string(body))
		require.Eventually(t, func() bool {
			machine, err := h.runtime.InspectWorkspace(t.Context(), entry.id)
			return err == nil && machine.State == workspaceapi.WorkspaceStopped
		}, 2*time.Minute, 100*time.Millisecond)
		awake := installedMemberTerminal(t, h, entry.id, browser)
		installedShell(t, awake, fmt.Sprintf(`test "$(stat -c '%%u:%%a' "$HOME")" = "$(id -u):700" && test "$(cat "$HOME/.claude/.credentials.json")" = mch-claude-%s-fixture && test "$(cat "$HOME/.codex/auth.json")" = mch-codex-%s-fixture && test "$(cat "$HOME/.config/gh/hosts.yml")" = mch-gh-%s-fixture`, entry.tag, entry.tag, entry.tag))
		// Retain the replacement connection, never reuse the closed pre-sleep PTY.
		if entry.tag == "B" {
			second = awake
		}
		if entry.tag == "A" {
			term = awake
		}
	}
	// Recomposition proves durable install recovery with the same disk and DB.
	// The physical host-service restart remains a separate reference-host check.
	term.close()
	second.close()
	h.recompose()
	term = installedMemberTerminal(t, h, branch, browser)
	second = installedMemberTerminal(t, h, secondBranch, browser)
	for _, entry := range []struct {
		tag  string
		term *rehearsalTerminal
	}{{"A", term}, {"B", second}} {
		installedShell(t, entry.term, fmt.Sprintf(`test "$(cat "$HOME/.claude/.credentials.json")" = mch-claude-%s-fixture && test "$(cat "$HOME/.codex/auth.json")" = mch-codex-%s-fixture && test "$(cat "$HOME/.config/gh/hosts.yml")" = mch-gh-%s-fixture`, entry.tag, entry.tag, entry.tag))
		awake := entry.term
		if entry.tag == "A" {
			installedShell(t, awake, `test "$(cat "$HOME/.marker")" = mch-marker-A-fixture && test "$(stat -c '%u:%a' "$HOME/.marker")" = "$(id -u):664"`)
			installedShell(t, awake, `printf 'mch-claude-A-refreshed\n' > "$HOME/.claude/.credentials.json"`)
			installedShell(t, second, `test "$(cat "$HOME/.claude/.credentials.json")" = mch-claude-B-fixture`)
			installedShell(t, awake, `rm "$HOME/.claude/.credentials.json" "$HOME/.codex/auth.json" "$HOME/.config/gh/hosts.yml"`)
			installedShell(t, second, `test "$(cat "$HOME/.claude/.credentials.json")" = mch-claude-B-fixture && test "$(cat "$HOME/.codex/auth.json")" = mch-codex-B-fixture && test "$(cat "$HOME/.config/gh/hosts.yml")" = mch-gh-B-fixture`)
		}
	}

	installedShell(t, second, `printf 'preboot-unchanged\n' > "$HOME/.mch-preboot-outside" && ln -s "$HOME/.mch-preboot-outside" "$HOME/.mch-preboot-link"`)
	second.close()
	code, body = h.request("POST", "/api/branches/"+secondBranch, `{"op":"sleep"}`, uuid.NewString())
	require.Equal(t, 202, code, string(body))
	require.Eventually(t, func() bool {
		machine, err := h.runtime.InspectWorkspace(t.Context(), secondBranch)
		return err == nil && machine.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	h.expect("POST", installedSecretsURL, `{"name":"MCH_PREBOOT_FILE","value":"must-not-replace-preboot","path":"~/.mch-preboot-link"}`, 201)
	second = installedMemberTerminal(t, h, secondBranch, browser)
	installedShell(t, second, `test "$(cat "$HOME/.claude/.credentials.json")" = mch-claude-B-fixture && test "$(cat "$HOME/.codex/auth.json")" = mch-codex-B-fixture && test "$(cat "$HOME/.config/gh/hosts.yml")" = mch-gh-B-fixture && test ! -e "$HOME/.marker"`)
	installedShell(t, second, `test -L "$HOME/.mch-preboot-link" && test "$(cat "$HOME/.mch-preboot-outside")" = preboot-unchanged`)
	h.expect("DELETE", installedSecretsURL+"/MCH_PREBOOT_FILE", "", 204)
	// Scan every persisted product table, rather than just audit metadata.
	// Table names come from PostgreSQL and are quoted as identifiers; sentinel
	// values remain bound parameters and are never printed in evidence.
	tables, err := h.pool.Query(t.Context(), `SELECT tablename FROM pg_tables WHERE schemaname='public'`)
	require.NoError(t, err)
	var names []string
	for tables.Next() {
		var name string
		require.NoError(t, tables.Scan(&name))
		names = append(names, name)
	}
	require.NoError(t, tables.Err())
	tables.Close()
	require.NotEmpty(t, names)
	for _, name := range names {
		for _, sentinel := range installedCredentialSentinels {
			var copies int
			require.NoError(t, h.pool.QueryRow(t.Context(), "SELECT count(*) FROM "+pgx.Identifier{"public", name}.Sanitize()+" t WHERE strpos(row_to_json(t)::text,$1)>0", sentinel).Scan(&copies))
			require.Zero(t, copies, "tool login appeared in table %s", name)
			require.NotContains(t, h.logs.String(), sentinel)
			require.NotContains(t, string(h.expect("GET", "/api/todos", "", 200)), sentinel)
		}
	}
}

func installedMemberTerminal(t *testing.T, h *rootLayerHarness, branch string, browsers ...http.CookieJar) *rehearsalTerminal {
	t.Helper()
	key := uuid.NewString()
	var receipt services.WorkspaceSessionResponse
	jar := http.CookieJar(h.jar)
	if len(browsers) > 0 {
		jar = browsers[0]
	}
	r := &rehearsal{ctx: t.Context(), origin: h.origin, jar: jar, client: h.client}
	call := func() (int, []byte) {
		code, body, err := r.keyedAs(jar, "POST", "/api/terminals", `{"branch":"`+branch+`"}`, key)
		require.NoError(t, err)
		return code, body
	}
	code, body := call()
	require.Equal(t, 202, code, string(body))
	require.NoError(t, json.Unmarshal(body, &receipt))
	require.Eventually(t, func() bool {
		code, body := call()
		var current services.WorkspaceSessionResponse
		return code == 202 && json.Unmarshal(body, &current) == nil && current.ID == receipt.ID && current.Status == "running"
	}, 2*time.Minute, 100*time.Millisecond)
	term, err := r.openTerminal(receipt.ID)
	require.NoError(t, err)
	t.Cleanup(term.close)
	return term
}

// Port of the T-MCH-02 spike: identical paths on two independent machine
// disks, with literal machine-tagged records. Each worker verifies all writes,
// rather than treating process exit or SQLite integrity alone as correctness.
const installedHomeWorkload = `import json, os, pathlib, sqlite3, sys, time
home = pathlib.Path(os.environ["HOME"])
vm = sys.argv[1]
for name in (".claude", ".config/gh", ".npm/_cacache"):
    base = home / name / "mch-load"
    base.mkdir(parents=True)
    dbs = []
    for mode in ("DELETE", "WAL"):
        db = sqlite3.connect(base / (mode + ".sqlite"))
        assert db.execute("PRAGMA journal_mode=" + mode).fetchone()[0].upper() == mode
        db.execute("PRAGMA synchronous=FULL")
        db.execute("CREATE TABLE writes(seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
        db.commit()
        dbs.append(db)
    rows = []
    with open(base / "append.jsonl", "a") as log:
        for seq in range(1, 1001):
            row = {"vm": vm, "seq": seq, "payload": vm + ":" + str(seq).zfill(6) + ":" + "x" * 128}
            value = json.dumps(row)
            rows.append(row)
            with open(base / (str(seq) + ".json"), "x") as f:
                f.write(value)
                f.flush()
                os.fsync(f.fileno())
            log.write(value + "\n")
            log.flush()
            os.fsync(log.fileno())
            with open(base / "shared.tmp", "w") as f:
                f.write(value)
                f.flush()
                os.fsync(f.fileno())
            os.replace(base / "shared.tmp", base / "shared.json")
            assert json.loads((base / "shared.json").read_text()) == row
            for db in dbs:
                db.execute("INSERT INTO writes VALUES (?, ?)", (seq, value))
                db.commit()
            time.sleep(0.002)
    assert [json.loads(line) for line in (base / "append.jsonl").read_text().splitlines()] == rows
    for row in rows:
        assert json.loads((base / (str(row["seq"]) + ".json")).read_text()) == row
    for db in dbs:
        assert db.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
        assert [json.loads(v) for (v,) in db.execute("SELECT payload FROM writes ORDER BY seq")] == rows
        db.close()
        # Reopen after closing WAL: acknowledged rows must survive recovery.
    for mode in ("DELETE", "WAL"):
        db = sqlite3.connect(base / (mode + ".sqlite"))
        assert [json.loads(v) for (v,) in db.execute("SELECT payload FROM writes ORDER BY seq")] == rows
        db.close()
`

func testInstalledHomeWorkload(t *testing.T, first, second *rehearsalTerminal) {
	t.Helper()
	results := make(chan error, 2)
	for i, term := range []*rehearsalTerminal{first, second} {
		go func(i int, term *rehearsalTerminal) {
			marker := fmt.Sprintf("MCHLOAD%d", i)
			// Only emit the success marker if the Python worker actually succeeded.
			script := fmt.Sprintf("python3 - %d <<'MCHPY' && printf 'MCHLOAD'\"%d\\n\"\n%s\nMCHPY", i, i, installedHomeWorkload)
			_, err := term.run(script, regexp.MustCompile(marker), 3*time.Minute)
			results <- err
		}(i, term)
	}
	for range 2 {
		require.NoError(t, <-results)
	}
}

// This checks the acceptance workload itself on Linux; it is deliberately
// separate from, and never counted as, the native composed-install receipt.
func TestInstalledHomeWorkloadFixture(t *testing.T) {
	if testing.Short() {
		t.Skip("1,000-write fsync campaign: run explicitly without -short")
	}
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	homes := []string{t.TempDir(), t.TempDir()}
	results := make(chan error, 2)
	for i, home := range homes {
		go func(i int, home string) {
			cmd := exec.CommandContext(t.Context(), python, "-c", installedHomeWorkload, fmt.Sprint(i))
			cmd.Env = append(os.Environ(), "HOME="+home)
			output, err := cmd.CombinedOutput()
			if err != nil {
				err = fmt.Errorf("worker %d: %w: %s", i, err, output)
			}
			results <- err
		}(i, home)
	}
	for range 2 {
		require.NoError(t, <-results)
	}
	for i, home := range homes {
		for _, dir := range []string{".claude", ".config/gh", ".npm/_cacache"} {
			data, err := os.ReadFile(filepath.Join(home, dir, "mch-load", "1000.json"))
			require.NoError(t, err)
			var row struct {
				VM  string `json:"vm"`
				Seq int    `json:"seq"`
			}
			require.NoError(t, json.Unmarshal(data, &row))
			require.Equal(t, fmt.Sprint(i), row.VM)
			require.Equal(t, 1000, row.Seq)
		}
	}
	// A duplicate campaign must fail rather than overwrite or hide old records.
	cmd := exec.CommandContext(t.Context(), python, "-c", installedHomeWorkload, "0")
	cmd.Env = append(os.Environ(), "HOME="+homes[0])
	output, err := cmd.CombinedOutput()
	require.Error(t, err)
	require.Contains(t, string(output), "FileExistsError")
}

// Inspect the raw authenticated stream, including transient hints and refused
// durable events. Store counts only: no token-containing event is retained.
type installedCredentialEventScan struct {
	mu     sync.Mutex
	frames int
	hits   int
}

var installedCredentialSentinels = []string{
	"mch-claude-A-fixture", "mch-codex-A-fixture", "mch-gh-A-fixture",
	"mch-claude-B-fixture", "mch-codex-B-fixture", "mch-gh-B-fixture",
	"mch-claude-A-refreshed",
}

func (s *installedCredentialEventScan) observe(_ string, payload []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames++
	for _, sentinel := range installedCredentialSentinels {
		if bytes.Contains(payload, []byte(sentinel)) {
			s.hits++
		}
	}
}

func startInstalledCredentialEventScan(t *testing.T, h *rootLayerHarness) *installedCredentialEventScan {
	t.Helper()
	scan := new(installedCredentialEventScan)
	stop, err := h.runtime.MachinedRegistry().ObserveEventFrames(scan.observe)
	require.NoError(t, err)
	t.Cleanup(func() { stop(); scan.assertClean(t) })
	return scan
}

func (s *installedCredentialEventScan) assertClean(t *testing.T) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	require.Positive(t, s.frames, "credential check must observe real daemon events")
	require.Zero(t, s.hits, "tool credential bytes appeared in raw daemon events")
}

func TestInstalledCredentialEventScanner(t *testing.T) {
	scan := new(installedCredentialEventScan)
	scan.observe("branch", []byte("ordinary capture"))
	require.Equal(t, 1, scan.frames)
	require.Zero(t, scan.hits)
	scan.observe("branch", []byte("\x00mch-claude-A-fixture\x00mch-codex-A-fixture\x00mch-gh-A-fixture\x00"))
	scan.observe("branch", []byte("mch-claude-B-fixture:mch-codex-B-fixture:mch-gh-B-fixture"))
	scan.observe("branch", []byte("prefix:mch-claude-A-refreshed:suffix"))
	require.Equal(t, 4, scan.frames)
	require.Equal(t, 7, scan.hits)
}
