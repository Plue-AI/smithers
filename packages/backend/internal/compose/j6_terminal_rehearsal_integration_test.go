package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// rehearsalTerminal is the owner's terminal WebSocket as the app's
// TerminalCard opens it: the browser session's cookie, the install's Origin
// and the terminal subprotocol. Every byte it prints is kept.
type rehearsalTerminal struct {
	conn   *websocket.Conn
	cancel context.CancelFunc
	mu     sync.Mutex
	output strings.Builder
	closed chan struct{}
}

func (r *rehearsal) openTerminal(sessionID string) (*rehearsalTerminal, error) {
	ctx, cancel := context.WithCancel(r.ctx)
	header := http.Header{"Origin": []string{r.origin}}
	url := "ws" + strings.TrimPrefix(r.origin, "http") + "/api/repos/rehearsal-owner/app/workspace/sessions/" + sessionID + "/terminal"
	dial, dialCancel := context.WithTimeout(ctx, 30*time.Second)
	defer dialCancel()
	conn, resp, err := websocket.Dial(dial, url, &websocket.DialOptions{HTTPClient: &http.Client{Jar: r.jar}, HTTPHeader: header, Subprotocols: []string{"terminal"}})
	if err != nil {
		cancel()
		if resp != nil {
			return nil, fmt.Errorf("terminal WebSocket: HTTP %d: %w", resp.StatusCode, err)
		}
		return nil, fmt.Errorf("terminal WebSocket: %w", err)
	}
	conn.SetReadLimit(1 << 20)
	term := &rehearsalTerminal{conn: conn, cancel: cancel, closed: make(chan struct{})}
	go func() {
		defer close(term.closed)
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			term.mu.Lock()
			term.output.Write(data)
			term.mu.Unlock()
		}
	}()
	return term, nil
}

// run types one command line and waits for pattern in what the terminal
// prints after it. Typed lines spell their markers split (J6""X) so the
// echo of the line never matches.
func (t *rehearsalTerminal) run(line string, pattern *regexp.Regexp, within time.Duration) ([]string, error) {
	t.mu.Lock()
	start := t.output.Len()
	t.mu.Unlock()
	if err := t.conn.Write(context.Background(), websocket.MessageBinary, []byte(line+"\n")); err != nil {
		return nil, fmt.Errorf("type %q: %w", line, err)
	}
	for deadline := time.Now().Add(within); ; time.Sleep(100 * time.Millisecond) {
		t.mu.Lock()
		printed := t.output.String()[start:]
		t.mu.Unlock()
		if match := pattern.FindStringSubmatch(printed); match != nil {
			return match, nil
		}
		select {
		case <-t.closed:
			return nil, fmt.Errorf("terminal closed waiting for %s; printed %q", pattern, tail(printed))
		default:
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("no %s within %s; printed %q", pattern, within, tail(printed))
		}
	}
}

func (t *rehearsalTerminal) close() {
	_ = t.conn.Close(websocket.StatusNormalClosure, "closed")
	t.cancel()
}

func tail(s string) string {
	if len(s) > 600 {
		return s[len(s)-600:]
	}
	return s
}

// terminalRows are J6 rows 5-9 (T-TRM-02, T-ACC-04): the owner opens a
// terminal on T1's branch; it is signed in to Smithers with a delegated
// credential in its own file; the CLI in it reads that credential; an edit
// lands on the branch; a wiki read through Claude Code is recorded as
// delegated via claude-code; and closing the terminal revokes it.
func (r *rehearsal) terminalRows(branch, sessionID string) {
	var term *rehearsalTerminal
	defer func() {
		if term != nil {
			term.close()
		}
	}()
	node, _ := exec.LookPath("node")
	cli := filepath.Join(r.root, "packages/smithers/bin/smithers.mjs")
	tokenPath, token := "", ""
	if !r.step("5 Terminal opens with a delegated token", "GET .../workspace/sessions/{id}/terminal (WebSocket); SMITHERS_TOKEN_FILE", "no SMITHERS_TOKEN; the token file has mode 600; access_tokens holds it delegated via terminal with branch and terminal_s1", "T-TRM-02, T-ACC-04", func() error {
		if sessionID == "" {
			return fmt.Errorf("blocked by Branch session: no terminal session")
		}
		var err error
		if term, err = r.openTerminal(sessionID); err != nil {
			return err
		}
		match, err := term.run(`printf '%s %s %s\n' J6""ENV "${SMITHERS_TOKEN_FILE:-none}" "${SMITHERS_TOKEN:+set}${SMITHERS_URL:+url}"`, regexp.MustCompile(`J6ENV (\S+) (\S+)`), 30*time.Second)
		if err != nil {
			return err
		}
		tokenPath = match[1]
		if match[2] != "url" {
			return fmt.Errorf("terminal environment %q: want SMITHERS_TOKEN unset and SMITHERS_URL set", match[2])
		}
		if want := "/run/smithers/sessions/" + sessionID + "/token"; !strings.HasSuffix(tokenPath, want) {
			return fmt.Errorf("SMITHERS_TOKEN_FILE %q does not end in %s", tokenPath, want)
		}
		info, err := os.Stat(tokenPath)
		if err != nil {
			return err
		}
		directory, err := os.Stat(filepath.Dir(tokenPath))
		if err != nil {
			return err
		}
		if info.Mode().Perm() != 0o600 || directory.Mode().Perm() != 0o700 {
			return fmt.Errorf("token file mode %o in a %o directory, want 600 in 700", info.Mode().Perm(), directory.Mode().Perm())
		}
		data, err := os.ReadFile(tokenPath)
		if err != nil {
			return err
		}
		token = strings.TrimSpace(string(data))
		var scopes string
		var systemIssued bool
		var expires time.Time
		if err = r.pool.QueryRow(r.ctx, `SELECT scopes, system_issued, expires_at FROM access_tokens WHERE name = $1`, "terminal-session-"+sessionID).Scan(&scopes, &systemIssued, &expires); err != nil {
			return fmt.Errorf("access_tokens row for the session: %w", err)
		}
		for _, entry := range []string{"via:terminal", "branch:" + branch, "profile:terminal_s1", "terminal-session:" + sessionID} {
			if !strings.Contains(","+scopes+",", ","+entry+",") {
				return fmt.Errorf("access_tokens scopes %q lack %s", scopes, entry)
			}
		}
		if !systemIssued || time.Until(expires) > time.Hour || time.Until(expires) < 50*time.Minute {
			return fmt.Errorf("token system_issued=%v expires in %s, want system-issued within 1 h", systemIssued, time.Until(expires).Round(time.Second))
		}
		r.actual = fmt.Sprintf("SMITHERS_TOKEN unset; .../run/smithers/sessions/%s/token mode 600 in 700; scopes %s", sessionID, scopes)
		return nil
	}) {
		return
	}
	r.step("6 auth status", "smthrs auth status in the terminal", "delegated, via terminal, as the member", "T-TRM-02, T-ACC-04", func() error {
		if term == nil || node == "" {
			return fmt.Errorf("blocked by Terminal opens (node %q)", node)
		}
		match, err := term.run(fmt.Sprintf(`%q %q auth status --json > "$TMPDIR/j6-status.json" 2>&1; printf '%%s %%s\n' J6""STATUS $?`, node, cli), regexp.MustCompile(`J6STATUS (\d+)`), 2*time.Minute)
		if err != nil {
			return err
		}
		// The trusted-process runtime's TMPDIR is the workspace's tmp beside
		// the run directory that holds the session's token.
		data, _ := os.ReadFile(filepath.Join(strings.TrimSuffix(tokenPath, "/run/smithers/sessions/"+sessionID+"/token"), "tmp", "j6-status.json"))
		var status struct {
			LoggedIn       bool   `json:"logged_in"`
			TokenSource    string `json:"token_source"`
			Username       string `json:"username"`
			CredentialKind string `json:"credential_kind"`
			Via            string `json:"via"`
		}
		if match[1] != "0" || json.Unmarshal(data, &status) != nil {
			return fmt.Errorf("auth status exit %s: %s", match[1], data)
		}
		r.actual = strings.Join(strings.Fields(string(data)), " ")
		if !status.LoggedIn || status.TokenSource != "token_file" || status.CredentialKind != "delegated" || status.Via != "terminal" || status.Username != "rehearsal-owner" {
			return fmt.Errorf("auth status is not the owner's delegated terminal credential")
		}
		return nil
	})
	// The branch's head is its checkout's working-copy commit (@), which the
	// guest's head publisher pushes to refs/smithers/branches/<id>/head on a
	// microVM. The trusted-process runtime runs no publisher on macOS (it needs
	// flock, bash 4 and the guest's helper path), so this row reads @ itself.
	r.step("7 Edit lands on the branch", "echo > j6-terminal.md in the terminal; jj log -r @ in T1's checkout", "the branch head (@) advances to a commit holding the edit", "T-TRM-02", func() error {
		if term == nil {
			return fmt.Errorf("blocked by Terminal opens")
		}
		head := regexp.MustCompile(`J6HEAD ([0-9a-f]{40}) (\S+)`)
		read := `printf '%s %s %s\n' J6""HEAD "$(jj log -r @ --no-graph -T commit_id 2>&1 | tail -1)" "$(jj file list -r @ 2>/dev/null | grep -c '^j6-terminal.md$')"`
		before, err := term.run(read, head, time.Minute)
		if err != nil {
			return err
		}
		after, err := term.run(`echo "edited in T1's terminal" > j6-terminal.md; `+read, head, time.Minute)
		if err != nil {
			return err
		}
		r.actual = fmt.Sprintf("@ %s → %s; j6-terminal.md in @: %s", before[1], after[1], after[2])
		if after[1] == before[1] || after[2] != "1" {
			return fmt.Errorf("the edit did not land on the branch's head")
		}
		return nil
	})
	r.step("8 Wiki read", "CLAUDECODE=1 smthrs api /api/repos/{o}/{r}/wiki in the terminal; audit_log", "200; recorded as delegated via claude-code", "T-TRM-02, T-ACC-04", func() error {
		if term == nil || node == "" {
			return fmt.Errorf("blocked by Terminal opens (node %q)", node)
		}
		match, err := term.run(fmt.Sprintf(`CLAUDECODE=1 %q %q api /api/repos/rehearsal-owner/app/wiki >/dev/null 2>&1; printf '%%s %%s\n' J6""WIKI $?`, node, cli), regexp.MustCompile(`J6WIKI (\d+)`), 2*time.Minute)
		if err != nil {
			return err
		}
		if match[1] != "0" {
			return fmt.Errorf("wiki read through the CLI exited %s", match[1])
		}
		var metadata []byte
		if err = r.pool.QueryRow(r.ctx, `SELECT metadata FROM audit_log WHERE event_type = 'delegated.request' AND action = 'GET' AND target_name = '/api/repos/rehearsal-owner/app/wiki' ORDER BY id DESC LIMIT 1`).Scan(&metadata); err != nil {
			return fmt.Errorf("no delegated audit row for the wiki read: %w", err)
		}
		var v struct {
			Kind      string `json:"kind"`
			Via       string `json:"via"`
			StoredVia string `json:"stored_via"`
			Session   string `json:"session"`
		}
		if err = json.Unmarshal(metadata, &v); err != nil {
			return err
		}
		r.actual = "200; audit " + string(metadata)
		if v.Kind != "delegated" || v.Via != "claude-code" || v.StoredVia != "terminal" || v.Session != sessionID {
			return fmt.Errorf("wiki read recorded as %s via %s (stored %s, session %s)", v.Kind, v.Via, v.StoredVia, v.Session)
		}
		return nil
	})
	r.step("9 Close revokes", "close the terminal WebSocket; GET /api/user with its token", "401 within 5 s; the token file is gone", "T-TRM-02, T-ACC-04", func() error {
		if term == nil || token == "" {
			return fmt.Errorf("blocked by Terminal opens")
		}
		probe := func() (int, error) {
			req, err := http.NewRequest("GET", r.origin+"/api/user", nil)
			if err != nil {
				return 0, err
			}
			req.Header.Set("Authorization", "Bearer "+token)
			resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
			if err != nil {
				return 0, err
			}
			resp.Body.Close()
			return resp.StatusCode, nil
		}
		if code, err := probe(); err != nil || code != 200 {
			return fmt.Errorf("the open terminal's token answered %d (%v), want 200", code, err)
		}
		closed := time.Now()
		term.close()
		term = nil
		for {
			code, err := probe()
			if err != nil {
				return err
			}
			if code == 401 {
				elapsed := time.Since(closed)
				if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
					return fmt.Errorf("token file still present after close: %v", err)
				}
				r.actual = fmt.Sprintf("401 %s after close; token file removed", elapsed.Round(time.Millisecond))
				if elapsed > 5*time.Second {
					return fmt.Errorf("revoked after %s, want within 5 s", elapsed)
				}
				return nil
			}
			if time.Since(closed) > 5*time.Second {
				return fmt.Errorf("token still answers %d 5 s after close", code)
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
}
