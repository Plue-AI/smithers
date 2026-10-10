package compose

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
type refusal struct{ method, path, body string }

// stackFacts is what a refused request must leave as it was: the number of
// TODOs, approvals, and T1's state and answers.
func (r *rehearsal) stackFacts(t1 int64) (string, error) {
	var items, approvals, tokens int
	if err := r.pool.QueryRow(r.ctx, `SELECT (SELECT count(*) FROM mythical_items), (SELECT count(*) FROM approvals), (SELECT count(*) FROM access_tokens WHERE name IN ('forbidden','forged'))`).Scan(&items, &approvals, &tokens); err != nil {
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
	return fmt.Sprintf("%d TODOs, %d approvals, %d tokens, T%d %s answer=%s steers=%s", items, approvals, tokens, t1, v.State, v.FirstAnswer, v.Steers), nil
}

// delegatedRows exercise the S2 catalog credential: answer attribution, never
// actions, forged headers and private confirmation rather than S1 allowlisting.
func (r *rehearsal) delegatedRows(t1, t2 int64, filed error) {
	var d *delegatedTerminal
	defer func() {
		if d != nil && d.term != nil {
			d.term.close()
		}
	}()
	const answer = "Say hello in Portuguese"
	branch2 := ""
	if !r.step("11 Answer Needs you as Claude Code for the member", "POST /api/terminals {branch: T2's}; CLAUDECODE=1 smthrs todo answer T2 in that terminal → POST /api/todos/{T2}/answer (delegated)",
		"202; first_answer.by is Claude Code for the terminal's member, with its session; todo.answered by {person, via claude-code, session}; T2 leaves Needs you", "T-ACC-04, T-APP-09", func() error {
			if filed != nil {
				return fmt.Errorf("file T2: %w", filed)
			}
			v, err := r.waitTodoWithin(t2, 8*time.Minute, "needs_you")
			if err != nil {
				return err
			}
			if v.Branch == nil || v.Branch.ID == "" || len(v.Waits) != 1 || v.Waits[0].Kind != "question" {
				return fmt.Errorf("T%d needs you without a branch or one question: %s", t2, r.actual)
			}
			branch2 = v.Branch.ID
			sessionID, err := r.openBranchTerminal(r.keyed, branch2)
			if err != nil {
				return fmt.Errorf("no terminal on T%d's branch: %w", t2, err)
			}
			d = &delegatedTerminal{r: r, session: sessionID}
			if d.term, err = r.openTerminal(sessionID); err != nil {
				return err
			}
			read, err := d.term.run(`printf '%s %s\n' J6""TOKEN "$(cat "${SMITHERS_TOKEN_FILE:-/nonexistent}")"`, regexp.MustCompile(`J6TOKEN (\S+)`), 30*time.Second)
			if err != nil {
				return err
			}
			d.token = read[1]
			code, printed, err := d.term.capture(fmt.Sprintf(`CLAUDECODE=1 smthrs todo answer T%d %q --json`, t2, answer), "J6ANSWER", 2*time.Minute)
			if err != nil {
				return err
			}
			if code != "0" {
				return fmt.Errorf("smthrs todo answer exited %s: %s", code, printed)
			}
			data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", t2), "", 200)
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
			case by.Kind != "agent" || by.Agent != "claude-code" || by.ForMember.Login != "rehearsal-owner" || by.SessionID != sessionID:
				return fmt.Errorf("the answer is not by Claude Code for rehearsal-owner in session %s", sessionID)
			case factBy["person"] != "rehearsal-owner" || factBy["via"] != "claude-code" || factBy["session"] != sessionID:
				return fmt.Errorf("todo.answered is not by {rehearsal-owner, claude-code, %s}", sessionID)
			case card.State == "needs_you":
				return fmt.Errorf("T%d still needs you after the answer", t2)
			}
			return nil
		}) {
		return
	}
	r.step("12 Catalog never actions refuse without effects", "T2 credential: personal token create; confirmation approve", "403 permission; no TODO or approval effects", "T-ACC-04", func() error {
		before, err := r.stackFacts(t1)
		if err != nil {
			return err
		}
		for _, request := range []refusal{{"POST", "/api/user/tokens", `{"name":"forbidden","scopes":["repo"]}`}, {"POST", "/api/confirmations/00000000-0000-0000-0000-000000000001/approve", `{}`}} {
			status, envelope, err := d.call(request.method, request.path, request.body, nil)
			if err != nil {
				return err
			}
			if status != 403 || envelope["class"] != "permission" {
				return fmt.Errorf("catalog never answered %d %v", status, envelope)
			}
		}
		after, err := r.stackFacts(t1)
		if err != nil {
			return err
		}
		if before != after {
			return fmt.Errorf("refusals changed stack: %s -> %s", before, after)
		}
		return nil
	})
	forged := map[string]string{"Smithers-Via": "browser", "Smithers-Actor": "ben", "Smithers-Profile": "full", "Smithers-Branch": "forged",
		"Smithers-Session": "forged", "X-Forwarded-User": "ben"}
	r.step("13 Forged headers", "T2's terminal credential with forged Smithers-Via, actor, profile, branch and session headers",
		"the same refusals; the request stays delegated via terminal with its own session", "T-ACC-04", func() error {
			if d == nil || d.token == "" {
				return fmt.Errorf("blocked by row 11: no terminal credential")
			}
			before, err := r.stackFacts(t1)
			if err != nil {
				return err
			}
			status, refusal, err := d.call("POST", "/api/user/tokens", `{"name":"forged","scopes":["repo"]}`, forged)
			if err != nil {
				return err
			}
			if status != 403 || refusal["class"] != "permission" {
				return fmt.Errorf("forged authority answered %d %v", status, refusal)
			}
			after, err := r.stackFacts(t1)
			if err != nil {
				return err
			}
			if before != after {
				return fmt.Errorf("forged refusal changed stack: %s -> %s", before, after)
			}
			status, _, err = d.call("GET", "/api/todos", "", forged)
			if err != nil || status != http.StatusOK {
				return fmt.Errorf("a forged read answered %d (%v)", status, err)
			}
			var metadata []byte
			var actor string
			if err = r.pool.QueryRow(r.ctx, `SELECT metadata, actor_name FROM audit_log WHERE event_type = 'delegated.request' AND action = 'GET' AND target_name = '/api/todos' ORDER BY id DESC LIMIT 1`).Scan(&metadata, &actor); err != nil {
				return fmt.Errorf("no delegated audit row for the forged read: %w", err)
			}
			var v struct {
				Kind, Via, Session, Profile, Branch string
				StoredVia                           string `json:"stored_via"`
			}
			if err = json.Unmarshal(metadata, &v); err != nil {
				return err
			}
			r.actual = fmt.Sprintf("forged token create 403; GET /todos 200 audited %s", metadata)
			if v.Kind != "delegated" || v.Via != "terminal" || v.Session != d.session || v.Profile != "" || v.Branch != branch2 || v.StoredVia != "terminal" || actor != "rehearsal-owner" {
				return fmt.Errorf("the forged read was recorded as %s via %s (session %s, profile %s)", v.Kind, v.Via, v.Session, v.Profile)
			}
			return nil
		})
	r.step("14 S2 draft requests confirmation", "POST /api/todos with T2 delegated credential", "202 private Confirm; no TODO before approval", "T-ACC-04, T-APP-04", func() error {
		before, err := r.todoList()
		if err != nil {
			return err
		}
		status, envelope, err := d.call("POST", "/api/todos", `{"title":"Owner follow-up","prompt":"Add a farewell to t2.md","place":{"mode":"append"}}`, nil)
		if err != nil {
			return err
		}
		id, _ := envelope["confirmation"].(string)
		if status != 202 || id == "" || envelope["state"] != "pending" {
			return fmt.Errorf("S2 draft answered %d %v", status, envelope)
		}
		after, err := r.todoList()
		if err != nil {
			return err
		}
		if len(after) != len(before) {
			return fmt.Errorf("draft created TODO before confirmation")
		}
		_, err = r.expect("POST", "/api/confirmations/"+id+"/deny", `{}`, 200)
		return err
	})
}
