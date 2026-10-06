package compose

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// delegatedTerminal is a terminal open on a TODO's branch with the delegated
// credential it was signed in with, as the agent working in it uses it.
type delegatedTerminal struct {
	r       *rehearsal
	term    *rehearsalTerminal
	session string
	token   string
	tmp     string
	sent    int
}

// call sends one request with the terminal's credential, as the CLI in it
// does under Claude Code (Smithers-Via: claude-code), plus headers.
func (d *delegatedTerminal) call(method, path, body string, headers map[string]string) (int, map[string]any, error) {
	req, err := http.NewRequest(method, d.r.origin+path, strings.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	d.sent++
	req.Header.Set("Authorization", "Bearer "+d.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", fmt.Sprintf("%sdelegated-%d", d.r.keyPrefix, d.sent))
	req.Header.Set("Smithers-Via", "claude-code")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	resp, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	d.r.log("%s %s (delegated) → %d %s\n", method, path, resp.StatusCode, data)
	var envelope map[string]any
	_ = json.Unmarshal(data, &envelope)
	return resp.StatusCode, envelope, nil
}

// refusal is one delegated request the terminal's credential must not make.
type refusal struct{ method, path, body, message string }

// refuse sends each request and fails unless every one is 403 permission
// with message (code permission, or confirm_in_app for "Confirm in the app").
func (d *delegatedTerminal) refuse(headers map[string]string, refusals []refusal) ([]string, error) {
	var seen []string
	for _, want := range refusals {
		status, envelope, err := d.call(want.method, want.path, want.body, headers)
		if err != nil {
			return seen, err
		}
		code := "permission"
		if want.message == "Confirm in the app" {
			code = "confirm_in_app"
		}
		if status != http.StatusForbidden || envelope["class"] != "permission" || envelope["code"] != code || envelope["message"] != want.message {
			return seen, fmt.Errorf("%s %s answered %d %v, want 403 %s %q", want.method, want.path, status, envelope, code, want.message)
		}
		seen = append(seen, fmt.Sprintf("%s %s 403 %s", want.method, strings.TrimPrefix(want.path, "/api"), code))
	}
	return seen, nil
}

// stackFacts is what a refused request must leave as it was: the number of
// TODOs, approvals, and T1's state and answers.
func (r *rehearsal) stackFacts(t1 int64) (string, error) {
	var items, approvals int
	if err := r.pool.QueryRow(r.ctx, `SELECT (SELECT count(*) FROM mythical_items), (SELECT count(*) FROM approvals)`).Scan(&items, &approvals); err != nil {
		return "", err
	}
	data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", t1), "", 200)
	if err != nil {
		return "", err
	}
	var v struct {
		State       string          `json:"state"`
		FirstAnswer json.RawMessage `json:"first_answer"`
		Steers      json.RawMessage `json:"steers"`
	}
	if err = json.Unmarshal(data, &v); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d TODOs, %d approvals, T%d %s answer=%s steers=%s", items, approvals, t1, v.State, v.FirstAnswer, v.Steers), nil
}

// delegatedRows are J6 rows 11-14 (T-ACC-04, spec §5.3.2a and §8.11.1): T2
// asks a question; the owner opens a terminal on T2's branch, and Claude Code
// in it answers through `smthrs todo answer` with the terminal's delegated
// credential, so the answer is by "Claude Code for" the terminal's member;
// that credential is refused everything else its profile does not name,
// forged headers change none of it, and its TODO draft is refused with
// confirm_in_app while the app serves no Confirm card for it. The member is
// the owner until Ben can open a branch session (row 17).
func (r *rehearsal) delegatedRows(t1, t2 int64, filed error) {
	var d *delegatedTerminal
	defer func() {
		if d != nil && d.term != nil {
			d.term.close()
		}
	}()
	node, _ := exec.LookPath("node")
	cli := filepath.Join(r.root, "packages/smithers/bin/smithers.mjs")
	const answer = "Say hello in Portuguese"
	branch1, branch2 := "", ""
	if !r.step("11 Answer Needs you as Claude Code for the member", "CLAUDECODE=1 smthrs todo answer T2 in T2's terminal → POST /api/todos/{T2}/answer (delegated)",
		"202; first_answer.by is Claude Code for the terminal's member, with its session; todo.answered by {person, via claude-code, session}; T2 leaves Needs you", "T-ACC-04, T-APP-09", func() error {
			if filed != nil {
				return fmt.Errorf("file T2: %w", filed)
			}
			if node == "" {
				return fmt.Errorf("no node on PATH")
			}
			v, err := r.waitTodoWithin(t2, 8*time.Minute, "needs_you")
			if err != nil {
				return err
			}
			if v.Branch == nil || v.Branch.ID == "" || len(v.Waits) != 1 || v.Waits[0].Kind != "question" {
				return fmt.Errorf("T%d needs you without a branch or one question: %s", t2, r.actual)
			}
			branch2 = v.Branch.ID
			if one, err := r.todo(t1); err == nil && one.Branch != nil {
				branch1 = one.Branch.ID
			}
			body, _ := json.Marshal(map[string]any{"workspace_id": branch2, "kind": "terminal", "cols": 200, "rows": 40})
			data, err := r.expect("POST", "/api/repos/rehearsal-owner/app/workspace/sessions", string(body), 201)
			if err != nil {
				return err
			}
			var session struct {
				ID string `json:"id"`
			}
			if err = json.Unmarshal(data, &session); err != nil || session.ID == "" {
				return fmt.Errorf("no terminal session on T%d's branch: %s", t2, data)
			}
			d = &delegatedTerminal{r: r, session: session.ID}
			if d.term, err = r.openTerminal(session.ID); err != nil {
				return err
			}
			match, err := d.term.run(`printf '%s %s\n' J6""FILE "${SMITHERS_TOKEN_FILE:-none}"`, regexp.MustCompile(`J6FILE (\S+)`), 30*time.Second)
			if err != nil {
				return err
			}
			token, err := os.ReadFile(match[1])
			if err != nil {
				return err
			}
			d.token = strings.TrimSpace(string(token))
			// The trusted-process runtime's TMPDIR is the workspace's tmp beside
			// the run directory that holds the session's token.
			d.tmp = filepath.Join(strings.TrimSuffix(match[1], "/run/smithers/sessions/"+session.ID+"/token"), "tmp")
			ran, err := d.term.run(fmt.Sprintf(`CLAUDECODE=1 %q %q todo answer T%d %q --json > "$TMPDIR/j6-answer.json" 2>&1; printf '%%s %%s\n' J6""ANSWER $?`, node, cli, t2, answer),
				regexp.MustCompile(`J6ANSWER (\d+)`), 2*time.Minute)
			if err != nil {
				return err
			}
			printed, _ := os.ReadFile(filepath.Join(d.tmp, "j6-answer.json"))
			if ran[1] != "0" {
				return fmt.Errorf("smthrs todo answer exited %s: %s", ran[1], printed)
			}
			data, err = r.expect("GET", fmt.Sprintf("/api/todos/%d", t2), "", 200)
			if err != nil {
				return err
			}
			var card struct {
				State       string `json:"state"`
				FirstAnswer struct {
					Text string `json:"text"`
					By   struct {
						Kind      string `json:"kind"`
						Agent     string `json:"agent"`
						SessionID string `json:"session_id"`
						ForMember struct {
							Login string `json:"login"`
						} `json:"for_member"`
					} `json:"by"`
				} `json:"first_answer"`
			}
			if err = json.Unmarshal(data, &card); err != nil {
				return err
			}
			var fact []byte
			if err = r.pool.QueryRow(r.ctx, `SELECT data->'by' FROM product_job_events WHERE event_type = 'todo.answered' AND (data->>'n')::bigint = $1 ORDER BY sequence DESC LIMIT 1`, t2).Scan(&fact); err != nil {
				return fmt.Errorf("no todo.answered fact for T%d: %w", t2, err)
			}
			by := card.FirstAnswer.By
			r.actual = fmt.Sprintf("%s; T%d %s; first_answer.by %s %s for %s session %s; fact by %s", strings.Join(strings.Fields(string(printed)), " "), t2, card.State, by.Kind, by.Agent, by.ForMember.Login, by.SessionID, fact)
			var factBy map[string]string
			_ = json.Unmarshal(fact, &factBy)
			switch {
			case card.FirstAnswer.Text != answer:
				return fmt.Errorf("T%d's first answer is %q", t2, card.FirstAnswer.Text)
			case by.Kind != "agent" || by.Agent != "claude-code" || by.ForMember.Login != "rehearsal-owner" || by.SessionID != session.ID:
				return fmt.Errorf("the answer is not by Claude Code for rehearsal-owner in session %s", session.ID)
			case factBy["person"] != "rehearsal-owner" || factBy["via"] != "claude-code" || factBy["session"] != session.ID:
				return fmt.Errorf("todo.answered is not by {rehearsal-owner, claude-code, %s}", session.ID)
			case card.State == "needs_you":
				return fmt.Errorf("T%d still needs you after the answer", t2)
			}
			return nil
		}) {
		return
	}
	other := "A terminal acts only on its own branch's TODO"
	cannot := "A terminal's credential cannot do this"
	r.step("12 Scope refusals", "T2's terminal credential: answer and steer T1; drop, stop, retry and merge T2; members; install; tokens; a second terminal",
		"403 permission each, with no effects; its own TODO's steer passes authorization", "T-ACC-04", func() error {
			if d == nil || d.token == "" {
				return fmt.Errorf("blocked by row 11: no terminal credential")
			}
			before, err := r.stackFacts(t1)
			if err != nil {
				return err
			}
			terminal, _ := json.Marshal(map[string]any{"workspace_id": branch2, "kind": "terminal"})
			seen, err := d.refuse(nil, []refusal{
				{"POST", fmt.Sprintf("/api/todos/%d/answer", t1), `{"wait":"q-0123456789abcdef","answer":"x"}`, other},
				{"POST", fmt.Sprintf("/api/todos/%d", t1), `{"op":"steer","text":"Use backoff"}`, other},
				{"POST", fmt.Sprintf("/api/todos/%d", t2), `{"op":"drop"}`, cannot},
				{"POST", fmt.Sprintf("/api/todos/%d", t2), `{"op":"stop"}`, cannot},
				{"POST", fmt.Sprintf("/api/todos/%d", t2), `{"op":"retry","steer":"again"}`, cannot},
				{"POST", fmt.Sprintf("/api/todos/%d/merge", t2), `{"reviewed_head_sha":"` + strings.Repeat("a", 40) + `"}`, cannot},
				{"POST", "/api/members", `{"login":"carol"}`, cannot},
				{"GET", "/api/install", "", cannot},
				{"GET", "/api/user/tokens", "", cannot},
				{"POST", "/api/repos/rehearsal-owner/app/workspace/sessions", string(terminal), cannot},
			})
			if err != nil {
				return err
			}
			// Its own branch's steer is admitted: the steer service answers.
			status, envelope, err := d.call("POST", fmt.Sprintf("/api/todos/%d", t2), `{"op":"steer","text":"Keep it short"}`, nil)
			if err != nil {
				return err
			}
			after, err := r.stackFacts(t1)
			if err != nil {
				return err
			}
			r.actual = fmt.Sprintf("%s; own steer %d %v; %s", strings.Join(seen, ", "), status, envelope["code"], after)
			if status == http.StatusForbidden || status == http.StatusUnauthorized {
				return fmt.Errorf("T%d's own steer was refused: %d %v", t2, status, envelope)
			}
			if before != after {
				return fmt.Errorf("refused requests changed the stack: %s → %s", before, after)
			}
			return nil
		})
	forged := map[string]string{"Smithers-Via": "browser", "Smithers-Actor": "rehearsal-owner", "Smithers-Profile": "full", "Smithers-Branch": branch1,
		"Smithers-Session": "forged", "X-Forwarded-User": "rehearsal-owner"}
	r.step("13 Forged headers", "T2's terminal credential with forged Smithers-Via, actor, profile, branch and session headers",
		"the same refusals; the request stays delegated via terminal with its own session", "T-ACC-04", func() error {
			if d == nil || d.token == "" {
				return fmt.Errorf("blocked by row 11: no terminal credential")
			}
			seen, err := d.refuse(forged, []refusal{
				{"POST", fmt.Sprintf("/api/todos/%d/merge", t2), `{"reviewed_head_sha":"` + strings.Repeat("a", 40) + `"}`, cannot},
				{"POST", fmt.Sprintf("/api/todos/%d/answer", t1), `{"wait":"q-0123456789abcdef","answer":"x"}`, other},
				{"POST", "/api/todos", `{"title":"Forged","prompt":"Add a farewell","place":{"mode":"append"}}`, "Confirm in the app"},
				{"GET", "/api/install", "", cannot},
			})
			if err != nil {
				return err
			}
			status, _, err := d.call("GET", "/api/todos", "", forged)
			if err != nil || status != http.StatusOK {
				return fmt.Errorf("a forged read answered %d (%v)", status, err)
			}
			var metadata []byte
			if err = r.pool.QueryRow(r.ctx, `SELECT metadata FROM audit_log WHERE event_type = 'delegated.request' AND action = 'GET' AND target_name = '/api/todos' ORDER BY id DESC LIMIT 1`).Scan(&metadata); err != nil {
				return fmt.Errorf("no delegated audit row for the forged read: %w", err)
			}
			var v struct {
				Kind, Via, Session, Profile string
			}
			if err = json.Unmarshal(metadata, &v); err != nil {
				return err
			}
			r.actual = fmt.Sprintf("%s; GET /todos 200 audited %s", strings.Join(seen, ", "), metadata)
			if v.Kind != "delegated" || v.Via != "terminal" || v.Session != d.session || v.Profile != "terminal_s1" {
				return fmt.Errorf("the forged read was recorded as %s via %s (session %s, profile %s)", v.Kind, v.Via, v.Session, v.Profile)
			}
			return nil
		})
	r.step("14 Missing card path", "POST /api/todos with T2's terminal credential (Claude Code's TODO draft, Append)",
		"403 permission/confirm_in_app, 'Confirm in the app'; no TODO, approval or other change", "T-ACC-04", func() error {
			if d == nil || d.token == "" {
				return fmt.Errorf("blocked by row 11: no terminal credential")
			}
			before, err := r.stackFacts(t1)
			if err != nil {
				return err
			}
			seen, err := d.refuse(nil, []refusal{{"POST", "/api/todos", `{"title":"Follow-up from Claude Code","prompt":"Add a farewell to t2.md","place":{"mode":"append"}}`, "Confirm in the app"}})
			if err != nil {
				return err
			}
			after, err := r.stackFacts(t1)
			if err != nil {
				return err
			}
			r.actual = fmt.Sprintf("%s; %s", strings.Join(seen, ", "), after)
			if before != after {
				return fmt.Errorf("the refused draft changed the stack: %s → %s", before, after)
			}
			return nil
		})
}
