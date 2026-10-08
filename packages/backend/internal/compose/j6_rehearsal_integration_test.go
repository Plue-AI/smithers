package compose

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

// j6Machined is why a terminal or guest row is pending on the
// trusted-process runtime: a member's terminal is an owner-uid PTY that only
// smithers-machined opens, inside a microVM (#3574 retired the shared-user
// terminal session on installs).
const j6Machined = "needs smithers-machined (microVM): runs on the Mac mini"

// TestJ6Rehearsal walks journey J6 (mvp.md §5, bring your own agent;
// C-J6-01) on the install J1 sets up, as the owner on the trusted-process
// runtime. T1 works on its own branch machine and the retired session door
// refuses a terminal; every row that needs a terminal or a real guest is
// pending on lane machined and runs in TestJ6MicroVMRehearsal.
func TestJ6Rehearsal(t *testing.T) {
	runJ6Rehearsal(t, "SMITHERS_J6_REHEARSAL", false)
}

// TestJ6MicroVMRehearsal is the same journey on the reference Mac's installed
// microVM runtime, where smithers-machined opens the owner's terminal: T1's
// branch terminal is requested at POST /api/terminals and signed in with its
// delegated credential (T-TRM-02); T2 asks a question, and Claude Code in a
// terminal on T2's branch answers it with that terminal's credential
// (delegatedRows). Run with SMITHERS_J6_MICROVM_REHEARSAL=1 and
// SMITHERS_CHECK_BUNDLE on the Mac mini.
func TestJ6MicroVMRehearsal(t *testing.T) {
	runJ6Rehearsal(t, "SMITHERS_J6_MICROVM_REHEARSAL", true)
}

func runJ6Rehearsal(t *testing.T, enable string, microVM bool) {
	t.Helper()
	r := newRehearsal(t, enable, "C-J6", "j6-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	defer func() { _ = r.release("t1") }()
	var t1 int64
	branch := ""
	if !r.step("1 T1 works on its branch", "POST /api/todos; GET /api/todos/{T1}", "working on its own branch machine, held at its edit", "T-STK-01, T-MCH-04", func() error {
		var err error
		if t1, err = r.file("T1 retries", "[HOLD t1] [FILE t1.md] Add a retry note to t1.md"); err != nil {
			return err
		}
		if err = r.waitHeld("t1", 8*time.Minute); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(t1, time.Minute, "working")
		if err != nil {
			return err
		}
		if v.Branch == nil || v.Branch.ID == "" {
			return fmt.Errorf("working T%d has no branch", t1)
		}
		branch = v.Branch.ID
		r.actual = fmt.Sprintf("200 T%d working on branch %s (%s)", t1, branch, v.Branch.Machine.State)
		return nil
	}) {
		return
	}
	r.step("2 The session door opens no terminal", "POST /api/repos/{o}/{r}/workspace/sessions {workspace_id: T1's branch, kind: terminal}", "400 'Open a branch terminal'; no terminal session row and no terminal credential", "T-TRM-01, T-TRM-02", func() error {
		count := func() (int, error) {
			var n int
			err := r.pool.QueryRow(r.ctx, `SELECT (SELECT count(*) FROM workspace_sessions WHERE workspace_id::text=$1 AND kind='terminal') + (SELECT count(*) FROM access_tokens WHERE name LIKE 'terminal-session-%')`, branch).Scan(&n)
			return n, err
		}
		before, err := count()
		if err != nil {
			return err
		}
		body, _ := json.Marshal(map[string]any{"workspace_id": branch, "kind": "terminal", "cols": 200, "rows": 40})
		data, err := r.expect("POST", "/api/repos/rehearsal-owner/app/workspace/sessions", string(body), 400)
		if err != nil {
			return err
		}
		var refusal struct {
			Message string `json:"message"`
		}
		if err = json.Unmarshal(data, &refusal); err != nil || refusal.Message != "Open a branch terminal" {
			return fmt.Errorf("the session door answered %s, want 'Open a branch terminal'", data)
		}
		after, err := count()
		if err != nil {
			return err
		}
		if after != before {
			return fmt.Errorf("the refused session door left %d terminal sessions or credentials, was %d", after, before)
		}
		return nil
	})
	if !microVM {
		r.step("2b The terminal door refuses without a machine daemon", "POST /api/terminals {branch: T1's branch}", "503 terminal_unavailable before any request, session or credential", "T-TRM-01", func() error {
			var before int
			if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'terminal.%'`).Scan(&before); err != nil {
				return err
			}
			body, _ := json.Marshal(map[string]string{"branch": branch})
			code, data, err := r.keyed("POST", "/api/terminals", string(body), uuid.NewString())
			if err != nil {
				return err
			}
			var refusal struct {
				Code string `json:"code"`
			}
			if code != 503 || json.Unmarshal(data, &refusal) != nil || refusal.Code != "terminal_unavailable" {
				return fmt.Errorf("POST /api/terminals answered %d %s, want 503 terminal_unavailable", code, data)
			}
			var after, tokens int
			if err = r.pool.QueryRow(r.ctx, `SELECT (SELECT count(*) FROM product_job_events WHERE event_type LIKE 'terminal.%'), (SELECT count(*) FROM access_tokens WHERE name LIKE 'terminal-session-%')`).Scan(&after, &tokens); err != nil {
				return err
			}
			if after != before || tokens != 0 {
				return fmt.Errorf("the refusal recorded %d terminal facts (was %d) and %d terminal credentials", after, before, tokens)
			}
			return nil
		})
		for _, row := range [][4]string{
			{"2c Branch terminal", "POST /api/terminals {branch: T1's branch}", "202 receipt on T1's branch; the same request again answers it; running", "T-TRM-01, T-APP-12"},
			{"3 App terminal door", "TodoCard → Open terminal → TerminalCard", "the app opens T1's terminal and echo ok prints ok (e2e terminal-signin.spec.ts)", "T-APP-12"},
			{"4 claude and codex signed in", "real microVM guest", "vendor and npm hosts reachable, others refused; claude and codex run", "T-MCH-12"},
			{"5 Terminal opens with a delegated token", "GET .../workspace/sessions/{id}/terminal (WebSocket); SMITHERS_TOKEN_FILE", "no SMITHERS_TOKEN; /run/smithers/<uid>/token/sessions/<id>/token mode 600 in 700; access_tokens holds it delegated via terminal", "T-TRM-02, T-ACC-04"},
			{"6 auth status", "smthrs auth status in the terminal", "delegated, via terminal, as the member", "T-TRM-02, T-ACC-04"},
			{"7 Edit lands on the branch", "echo > j6-terminal.md in the terminal; jj log -r @", "the branch head (@) advances to a commit holding the edit", "T-TRM-02"},
			{"8 Wiki read", "CLAUDECODE=1 smthrs api /api/repos/{o}/{r}/wiki in the terminal; audit_log", "200; recorded as delegated via claude-code", "T-TRM-02, T-ACC-04"},
			{"9 Close revokes", "close the terminal WebSocket; GET /api/user with its token", "401 within 5 s; the token file is gone", "T-TRM-02, T-ACC-04"},
			{"10 Skill discoverable", "guest smthrs --version; SKILL.md files", "the CLI runs and the skill is installed", "T-TRM-02"},
			{"11 Answer Needs you as Claude Code for the member", "CLAUDECODE=1 smthrs todo answer T2 in T2's terminal", "202; first_answer.by is Claude Code for the terminal's member, with its session", "T-ACC-04, T-APP-09"},
			{"12 Scope refusals", "T2's terminal credential", "403 permission each, with no effects; its own TODO's steer passes authorization", "T-ACC-04"},
			{"13 Forged headers", "T2's terminal credential with forged headers", "the same refusals; the request stays delegated via terminal with its own session", "T-ACC-04"},
			{"14 Missing card path", "POST /api/todos with T2's terminal credential", "403 permission/confirm_in_app, 'Confirm in the app'; no change", "T-ACC-04"},
			{"15 Delegated follow-up", "delegated TODO draft", "202; one private Confirm row; no TODO yet; 403 for anyone else", "T-APP-04"},
			{"16 Ben confirms", "Confirm press", "one TODO at the end of the stack by Claude Code for Ben; a second press creates nothing", "T-APP-04"},
			{"17 Ben's branch terminal", "POST /api/terminals {branch} as maintainer Ben", "202 and running for Ben; 403 for a non-member", "T-ACC-02, T-TRM-01"},
		} {
			r.pending(row[0], row[1], row[2]+" ("+j6Machined+")", row[3], "machined")
		}
		return
	}
	// T2 asks a question for the delegated rows (11-14); filed now, it
	// reaches Needs you while the terminal rows run.
	t2, filed := r.file("T2 asks", "[ASK] [FILE t2.md] Add a greeting to t2.md")
	sessionID := ""
	r.step("2c Branch terminal", "POST /api/terminals {branch: T1's branch} ×2", "202 receipt on T1's branch; the same request again answers it; running", "T-TRM-01, T-APP-12", func() error {
		var err error
		sessionID, err = r.openBranchTerminal(r.keyed, branch)
		return err
	})
	r.pending("3 App terminal door", "TodoCard → Open terminal → TerminalCard", "the app opens T1's terminal and echo ok prints ok (e2e terminal-signin.spec.ts)", "T-APP-12", "terminal-door")
	r.pending("4 claude and codex signed in", "real microVM guest", "vendor and npm hosts reachable, others refused; claude and codex run", "T-MCH-12", "vendor-egress")
	r.terminalRows(branch, sessionID)
	r.pending("10 Skill discoverable", "guest smthrs --version; SKILL.md files", "the CLI runs and the skill is installed", "T-TRM-02", "guest-cli-skill")
	r.delegatedRows(t1, t2, filed)
	r.pending("15 Delegated follow-up", "delegated TODO draft", "202; one private Confirm row; no TODO yet; 403 for anyone else", "T-APP-04", "delegated-confirm")
	r.pending("16 Ben confirms", "Confirm press", "one TODO at the end of the stack by Claude Code for Ben; a second press creates nothing", "T-APP-04", "delegated-confirm")
	r.pending("17 Ben's branch terminal", "POST /api/terminals {branch} as maintainer Ben", "202 and running for Ben; 403 for a non-member", "T-ACC-02, T-TRM-01", "members")
}

// openBranchTerminal requests the member's own terminal on branch through
// the terminal door (send is the member's browser) and waits until it runs.
// The door answers a receipt at once; the same request again answers that
// receipt with the terminal's settled status.
func (r *rehearsal) openBranchTerminal(send func(method, path, body, key string) (int, []byte, error), branch string) (string, error) {
	body, _ := json.Marshal(map[string]string{"branch": branch})
	key := uuid.NewString()
	type receipt struct {
		ID          string `json:"id"`
		WorkspaceID string `json:"workspace_id"`
		Status      string `json:"status"`
		Kind        string `json:"kind"`
	}
	request := func() (receipt, error) {
		code, data, err := send("POST", "/api/terminals", string(body), key)
		if err != nil {
			return receipt{}, err
		}
		var v receipt
		if code != 202 || json.Unmarshal(data, &v) != nil {
			return receipt{}, fmt.Errorf("POST /api/terminals: HTTP %d %s", code, data)
		}
		return v, nil
	}
	began := time.Now()
	first, err := request()
	if err != nil {
		return "", err
	}
	if took := time.Since(began); took > time.Second {
		return "", fmt.Errorf("the terminal door answered after %s, want a receipt within 1 s", took.Round(time.Millisecond))
	}
	if first.ID == "" || first.WorkspaceID != branch || first.Kind != "terminal" {
		return "", fmt.Errorf("terminal receipt %+v, want a terminal on branch %s", first, branch)
	}
	for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(time.Second) {
		again, err := request()
		if err != nil {
			return "", err
		}
		if again.ID != first.ID {
			return "", fmt.Errorf("the same request answered terminal %s, then %s", first.ID, again.ID)
		}
		switch again.Status {
		case "running":
			r.actual = fmt.Sprintf("202 %s (%s), then running after %s", first.ID, first.Status, time.Since(began).Round(time.Second))
			return first.ID, nil
		case "failed", "closed":
			return "", fmt.Errorf("terminal %s is %s; it never ran", first.ID, again.Status)
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("terminal %s still %s after 5 min", first.ID, again.Status)
		}
	}
}
