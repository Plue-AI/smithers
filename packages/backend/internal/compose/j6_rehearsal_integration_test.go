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
// terminal session on that branch. The terminal sign-in, skill, delegated
// actions and Confirm rows wait on their lanes and are listed as pending.
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
	r.step("2 Branch session", "POST /api/repos/{o}/{r}/workspace/sessions {workspace_id: T1's branch, kind: terminal}", "201; a terminal session on T1's branch machine for the owner", "T-APP-10, T-TRM-01", func() error {
		body, _ := json.Marshal(map[string]any{"workspace_id": branch, "kind": "terminal", "cols": 80, "rows": 24})
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
		return nil
	})
	r.pending("3 App terminal door", "TodoCard → Open terminal → TerminalCard", "the app opens T1's terminal and echo ok prints ok (e2e terminal-signin.spec.ts)", "T-APP-12", "terminal-door")
	r.pending("4 claude and codex signed in", "real microVM guest", "vendor and npm hosts reachable, others refused; claude and codex run (not provable on trusted-process)", "T-MCH-12", "vendor-egress")
	r.pending("5 Terminal opens with a delegated token", "terminal open; /run/smithers/sessions/<id>/token", "no SMITHERS_TOKEN; the token file has mode 600", "T-TRM-02, T-ACC-04", "terminal-credential")
	r.pending("6 auth status", "smthrs auth status in the terminal", "delegated, via terminal, as the member", "T-TRM-02, T-ACC-04", "terminal-credential")
	r.pending("7 Edit lands on the branch", "edit in the terminal", "the branch head advances", "T-TRM-02", "terminal-credential")
	r.pending("8 Wiki read", "wiki read through the skill", "recorded as delegated via claude-code", "T-TRM-02, T-ACC-04", "terminal-credential")
	r.pending("9 Close revokes", "close the terminal; reuse its token", "401 within 5 s", "T-TRM-02, T-ACC-04", "terminal-credential")
	r.pending("10 Skill discoverable", "guest smthrs --version; SKILL.md files", "the CLI runs and the skill is installed", "T-TRM-02", "guest-cli-skill")
	r.pending("11 Answer Needs you as Claude Code for Ben", "POST /api/todos/{n}/answer with a delegated token", "first_answer.by is Claude Code for the member", "T-ACC-04, T-APP-09", "delegated-actions")
	r.pending("12 Scope refusals", "out-of-scope delegated calls", "403 permission with no effects", "T-ACC-04", "delegated-actions")
	r.pending("13 Forged headers", "delegated call with forged actor headers", "refused", "T-ACC-04", "delegated-actions")
	r.pending("14 Missing card path", "delegated TODO draft without the card path", "403 permission/confirm_in_app, 'Confirm in the app'", "T-ACC-04", "delegated-actions")
	r.pending("15 Delegated follow-up", "delegated TODO draft", "202; one private Confirm row; no TODO yet; 403 for anyone else", "T-APP-04", "delegated-confirm")
	r.pending("16 Ben confirms", "Confirm press", "one TODO at the end of the stack by Claude Code for Ben; a second press creates nothing", "T-APP-04", "delegated-confirm")
	r.pending("17 Ben's branch session", "POST /api/repos/{o}/{r}/workspace/sessions as maintainer Ben", "201 for Ben; 403 for a non-member", "T-ACC-02", "members")
}
