package compose

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// TestJ6Rehearsal walks journey J6 (mvp.md §5, bring your own agent;
// C-J6-01) on the install J1 sets up, as the owner on the trusted-process
// runtime: T1 works on its own branch machine, held at its edit
// (distribution/fake-todo-turns.mjs [HOLD t1]), and the owner opens a
// terminal session on that branch; T2 asks a question, and Claude Code in a
// terminal on T2's branch answers it with that terminal's delegated
// credential (delegatedRows). The app door, egress, skill, Confirm and Ben's
// session rows wait on their lanes and are listed as pending.
func TestJ6Rehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J6_REHEARSAL", "C-J6", "j6-")
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
	// T2 asks a question for the delegated rows (11-14); filed now, it
	// reaches Needs you while the terminal rows run.
	t2, filed := r.file("T2 asks", "[ASK] [FILE t2.md] Add a greeting to t2.md")
	sessionID := ""
	r.step("2 Branch session", "POST /api/repos/{o}/{r}/workspace/sessions {workspace_id: T1's branch, kind: terminal}", "201; a terminal session on T1's branch machine for the owner", "T-APP-10, T-TRM-01", func() error {
		body, _ := json.Marshal(map[string]any{"workspace_id": branch, "kind": "terminal", "cols": 200, "rows": 40})
		data, err := r.expect("POST", "/api/repos/rehearsal-owner/app/workspace/sessions", string(body), 201)
		if err != nil {
			return err
		}
		var session struct {
			ID          string `json:"id"`
			WorkspaceID string `json:"workspace_id"`
		}
		if err = json.Unmarshal(data, &session); err != nil {
			return err
		}
		if session.ID == "" || session.WorkspaceID != branch {
			return fmt.Errorf("session %q on workspace %q, want T%d's branch %s", session.ID, session.WorkspaceID, t1, branch)
		}
		sessionID = session.ID
		return nil
	})
	r.pending("3 App terminal door", "TodoCard → Open terminal → TerminalCard", "the app opens T1's terminal and echo ok prints ok (e2e terminal-signin.spec.ts)", "T-APP-12", "terminal-door")
	r.pending("4 claude and codex signed in", "real microVM guest", "vendor and npm hosts reachable, others refused; claude and codex run (not provable on trusted-process)", "T-MCH-12", "vendor-egress")
	r.terminalRows(branch, sessionID)
	r.pending("10 Skill discoverable", "guest smthrs --version; SKILL.md files", "the CLI runs and the skill is installed", "T-TRM-02", "guest-cli-skill")
	r.delegatedRows(t1, t2, filed)
	r.pending("15 Delegated follow-up", "delegated TODO draft", "202; one private Confirm row; no TODO yet; 403 for anyone else", "T-APP-04", "delegated-confirm")
	r.pending("16 Ben confirms", "Confirm press", "one TODO at the end of the stack by Claude Code for Ben; a second press creates nothing", "T-APP-04", "delegated-confirm")
	r.pending("17 Ben's branch session", "POST /api/repos/{o}/{r}/workspace/sessions as maintainer Ben", "201 for Ben; 403 for a non-member", "T-ACC-02", "members")
}
