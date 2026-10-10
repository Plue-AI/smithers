package compose

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
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
	return r.openTerminalAs(r.jar, sessionID)
}

func (r *rehearsal) openTerminalAs(jar http.CookieJar, sessionID string) (*rehearsalTerminal, error) {
	ctx, cancel := context.WithCancel(r.ctx)
	header := http.Header{"Origin": []string{r.origin}}
	url := "ws" + strings.TrimPrefix(r.origin, "http") + "/api/repos/rehearsal-owner/app/workspace/sessions/" + sessionID + "/terminal"
	dial, dialCancel := context.WithTimeout(ctx, 30*time.Second)
	defer dialCancel()
	conn, resp, err := websocket.Dial(dial, url, &websocket.DialOptions{HTTPClient: &http.Client{Jar: jar}, HTTPHeader: header, Subprotocols: []string{"terminal"}})
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

// capture runs command in the terminal and answers its exit status and
// output. The guest's files are not the host's, so the output comes back
// base64 on one line after marker, spelled split in the typed line.
func (t *rehearsalTerminal) capture(command, marker string, within time.Duration) (string, []byte, error) {
	line := fmt.Sprintf(`j6out=$(%s 2>&1); j6code=$?; printf '%%s %%s %%s\n' %s "$j6code" "$(printf %%s "$j6out" | base64 | tr -d '\n')"`, command, marker[:2]+`""`+marker[2:])
	match, err := t.run(line, regexp.MustCompile(regexp.QuoteMeta(marker)+` (\d+) ([A-Za-z0-9+/=]*)`), within)
	if err != nil {
		return "", nil, err
	}
	output, err := base64.StdEncoding.DecodeString(match[2])
	return match[1], output, err
}

func tail(s string) string {
	if len(s) > 600 {
		return s[len(s)-600:]
	}
	return s
}

// terminalRows are J6 rows 5-9 (T-TRM-02, T-ACC-04) on a microVM: the
// owner's terminal on T1's branch, an owner-uid PTY smithers-machined opens,
// is signed in to Smithers with a delegated credential in its own session
// file; the guest's smthrs CLI reads that credential; an edit lands on the
// branch; a wiki read through Claude Code is recorded as delegated via
// claude-code; and closing the terminal revokes it.
func (r *rehearsal) terminalRows(branch, sessionID string) {
	var term *rehearsalTerminal
	defer func() {
		if term != nil {
			term.close()
		}
	}()
	tokenPath, token := "", ""
	if !r.step("5 Terminal opens with a delegated token", "GET .../workspace/sessions/{id}/terminal (WebSocket); SMITHERS_TOKEN_FILE", "no SMITHERS_TOKEN; /run/smithers/<uid>/token/sessions/<id>/token, mode 600 and the owner's, in 700 directories; access_tokens holds it delegated via terminal with branch and S2 catalog delegation", "T-TRM-02, T-ACC-04", func() error {
		if sessionID == "" {
			return fmt.Errorf("blocked by row 2c: no branch terminal")
		}
		var err error
		if term, err = r.openTerminal(sessionID); err != nil {
			return err
		}
		match, err := term.run(`printf '%s %s %s %s\n' J6""ENV "${SMITHERS_TOKEN_FILE:-none}" "${SMITHERS_TOKEN:+set}${SMITHERS_URL:+url}" "$(id -u)"`, regexp.MustCompile(`J6ENV (\S+) (\S+) (\d+)`), 30*time.Second)
		if err != nil {
			return err
		}
		tokenPath = match[1]
		uid := match[3]
		if match[2] != "url" {
			return fmt.Errorf("terminal environment %q: want SMITHERS_TOKEN unset and SMITHERS_URL set", match[2])
		}
		var member string
		if err = r.pool.QueryRow(r.ctx, `SELECT c.unix_uid::text FROM collaborators c JOIN users u ON u.id=c.user_id WHERE u.lower_username='rehearsal-owner'`).Scan(&member); err != nil {
			return fmt.Errorf("the owner's unix uid: %w", err)
		}
		if uid != member {
			return fmt.Errorf("the terminal runs as uid %s, want the owner's %s", uid, member)
		}
		if want := "/run/smithers/" + uid + "/token/sessions/" + sessionID + "/token"; tokenPath != want {
			return fmt.Errorf("SMITHERS_TOKEN_FILE %q, want %s", tokenPath, want)
		}
		modes, err := term.run(`printf '%s %s %s %s\n' J6""MODE "$(stat -c %a:%u "$SMITHERS_TOKEN_FILE")" "$(stat -c %a:%u "${SMITHERS_TOKEN_FILE%/token}")" "$(stat -c %a:%u /run/smithers/$(id -u))"`, regexp.MustCompile(`J6MODE (\S+) (\S+) (\S+)`), 30*time.Second)
		if err != nil {
			return err
		}
		if modes[1] != "600:"+uid || modes[2] != "700:"+uid || modes[3] != "700:"+uid {
			return fmt.Errorf("token file %s in session directory %s under member directory %s, want 600, 700 and 700, each the owner's", modes[1], modes[2], modes[3])
		}
		read, err := term.run(`printf '%s %s\n' J6""TOKEN "$(cat "$SMITHERS_TOKEN_FILE")"`, regexp.MustCompile(`J6TOKEN (\S+)`), 30*time.Second)
		if err != nil {
			return err
		}
		token = read[1]
		var scopes string
		var systemIssued bool
		var expires time.Time
		if err = r.pool.QueryRow(r.ctx, `SELECT scopes, system_issued, expires_at FROM access_tokens WHERE name = $1`, "terminal-session-"+sessionID).Scan(&scopes, &systemIssued, &expires); err != nil {
			return fmt.Errorf("access_tokens row for the session: %w", err)
		}
		for _, entry := range []string{"repo", "user", "workspace", "agent", "via:terminal", "branch:" + branch, "terminal-session:" + sessionID} {
			if !strings.Contains(","+scopes+",", ","+entry+",") {
				return fmt.Errorf("access_tokens scopes %q lack %s", scopes, entry)
			}
		}
		if strings.Contains(scopes, "profile:") {
			return fmt.Errorf("S2 credential retains a restricted profile: %s", scopes)
		}
		if !systemIssued || time.Until(expires) > time.Hour || time.Until(expires) < 50*time.Minute {
			return fmt.Errorf("token system_issued=%v expires in %s, want system-issued within 1 h", systemIssued, time.Until(expires).Round(time.Second))
		}
		r.actual = fmt.Sprintf("SMITHERS_TOKEN unset; %s mode 600 in 700 as uid %s; scopes %s", tokenPath, uid, scopes)
		return nil
	}) {
		return
	}
	r.step("10 Skill discoverable", "guest smthrs --version; both skill discovery directories", "packaged CLI runs and Claude Code/Codex discover the installed skill", "T-TRM-02", func() error {
		code, data, err := term.capture(`test "$(command -v smthrs)" = /opt/smithers/bundle/bin/linux-arm64/smthrs && smthrs --version && test "$(readlink "$HOME/.claude/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers && test "$(readlink "$HOME/.agents/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers && test -s "$HOME/.agents/skills/smithers/SKILL.md"`, "J6SKILL", 2*time.Minute)
		if err != nil {
			return err
		}
		if code != "0" || len(data) == 0 {
			return fmt.Errorf("CLI/skill discovery exit %s: %s", code, data)
		}
		r.actual = string(data)
		return nil
	})
	r.step("6 auth status", "smthrs auth status in the terminal", "delegated, via terminal, as the member", "T-TRM-02, T-ACC-04", func() error {
		if term == nil {
			return fmt.Errorf("blocked by Terminal opens")
		}
		code, data, err := term.capture("smthrs auth status --json", "J6STATUS", 2*time.Minute)
		if err != nil {
			return err
		}
		var status struct {
			LoggedIn       bool   `json:"logged_in"`
			TokenSource    string `json:"token_source"`
			Username       string `json:"username"`
			CredentialKind string `json:"credential_kind"`
			Via            string `json:"via"`
		}
		if code != "0" || json.Unmarshal(data, &status) != nil {
			return fmt.Errorf("auth status exit %s: %s", code, data)
		}
		r.actual = strings.Join(strings.Fields(string(data)), " ")
		if !status.LoggedIn || status.TokenSource != "token_file" || status.CredentialKind != "delegated" || status.Via != "terminal" || status.Username != "rehearsal-owner" {
			return fmt.Errorf("auth status is not the owner's delegated terminal credential")
		}
		return nil
	})
	// The branch's head is its checkout's working-copy commit (@), which the
	// guest's head publisher pushes to refs/smithers/branches/<id>/head. The
	// row reads @ in the terminal's checkout.
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
		if term == nil {
			return fmt.Errorf("blocked by Terminal opens")
		}
		match, err := term.run(`CLAUDECODE=1 smthrs api /api/repos/rehearsal-owner/app/wiki >/dev/null 2>&1; printf '%s %s\n' J6""WIKI $?`, regexp.MustCompile(`J6WIKI (\d+)`), 2*time.Minute)
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
		if term == nil || token == "" || tokenPath == "" {
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
				if elapsed > 5*time.Second {
					return fmt.Errorf("revoked after %s, want within 5 s", elapsed)
				}
				// The file is in the guest: a fresh terminal of the same
				// member looks for it.
				fresh, err := r.openBranchTerminal(r.keyed, branch)
				if err != nil {
					return fmt.Errorf("a fresh terminal to look for the closed one's token file: %w", err)
				}
				look, err := r.openTerminal(fresh)
				if err != nil {
					return err
				}
				defer look.close()
				gone, err := look.run(fmt.Sprintf(`if test -e %q; then echo J6""GONE no; else echo J6""GONE yes; fi`, tokenPath), regexp.MustCompile(`J6GONE (yes|no)`), 30*time.Second)
				if err != nil {
					return err
				}
				if gone[1] != "yes" {
					return fmt.Errorf("token file %s still present after close", tokenPath)
				}
				r.actual = fmt.Sprintf("401 %s after close; token file removed", elapsed.Round(time.Millisecond))
				return nil
			}
			if time.Since(closed) > 5*time.Second {
				return fmt.Errorf("token still answers %d 5 s after close", code)
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
}
