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
// does under Claude Code (Smithers-Via: claude-code), plus headers, and
// answers the response's JSON object.
func (d *delegatedTerminal) call(method, path, body string, headers map[string]string) (int, map[string]any, error) {
	status, data, err := d.send(method, path, body, headers)
	var envelope map[string]any
	_ = json.Unmarshal(data, &envelope)
	return status, envelope, err
}

// send is call answering the response's body.
func (d *delegatedTerminal) send(method, path, body string, headers map[string]string) (int, []byte, error) {
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
	return resp.StatusCode, data, nil
}

// refusal is one delegated request the terminal's credential must not make.
type refusal struct{ method, path, body, message string }

// refuse sends each request and fails unless every one is 403 permission
// with message.
func (d *delegatedTerminal) refuse(headers map[string]string, refusals []refusal) ([]string, error) {
	var seen []string
	for _, want := range refusals {
		status, envelope, err := d.call(want.method, want.path, want.body, headers)
		if err != nil {
			return seen, err
		}
		if status != http.StatusForbidden || envelope["class"] != "permission" || envelope["code"] != "permission" || envelope["message"] != want.message {
			return seen, fmt.Errorf("%s %s answered %d %v, want 403 permission %q", want.method, want.path, status, envelope, want.message)
		}
		seen = append(seen, fmt.Sprintf("%s %s 403", want.method, strings.TrimPrefix(want.path, "/api")))
	}
	return seen, nil
}

// draft is the terminal's TODO draft with headers: 202 {confirmation, state:
// pending}, never a TODO. It answers the confirmation's id.
func (d *delegatedTerminal) draft(title, prompt string, headers map[string]string) (string, error) {
	body, _ := json.Marshal(map[string]any{"title": title, "prompt": prompt, "place": map[string]string{"mode": "append"}})
	status, envelope, err := d.call("POST", "/api/todos", string(body), headers)
	if err != nil {
		return "", err
	}
	id, _ := envelope["confirmation"].(string)
	if status != http.StatusAccepted || envelope["state"] != "pending" || id == "" || envelope["n"] != nil {
		return "", fmt.Errorf("the terminal's TODO draft answered %d %v, want 202 {confirmation, state: pending}", status, envelope)
	}
	return id, nil
}

// rehearsalAgent is an agent Actor acting for a member: "Claude Code for
// Ben" in its session.
type rehearsalAgent struct {
	Kind      string `json:"kind"`
	Agent     string `json:"agent"`
	SessionID string `json:"session_id"`
	ForMember struct {
		Login string `json:"login"`
	} `json:"for_member"`
}

// rehearsalConfirmation is one row of GET /api/confirmations as a person's
// browser reads it.
type rehearsalConfirmation struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Todo  int64  `json:"todo"`
	Card  struct {
		Kind    string         `json:"kind"`
		Text    string         `json:"text"`
		AskedBy rehearsalAgent `json:"asked_by"`
		Receipt *struct {
			Result string `json:"result"`
			Text   string `json:"text"`
		} `json:"receipt"`
	} `json:"card"`
}

// confirmations reads GET /api/confirmations from the browser that holds jar
// and answers the row with id, if listed.
func (r *rehearsal) confirmations(jar http.CookieJar, id string) ([]rehearsalConfirmation, *rehearsalConfirmation, error) {
	data, err := r.expectAs(jar, "GET", "/api/confirmations", "", 200)
	if err != nil {
		return nil, nil, err
	}
	var list []rehearsalConfirmation
	if err = json.Unmarshal(data, &list); err != nil {
		return nil, nil, err
	}
	for i := range list {
		if list[i].ID == id {
			return list, &list[i], nil
		}
	}
	return list, nil, nil
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

// delegatedRows are J6 rows 11-16 (T-ACC-04 and T-APP-04, spec §5.3.2a,
// §5.4 and §8.11.1): T2 asks a question; the owner opens a terminal on T2's
// branch, and Claude Code in it answers through `smthrs todo answer` with the
// terminal's delegated credential, so the answer is by "Claude Code for" the
// terminal's member; that credential is refused everything else its profile
// does not name, and forged headers change none of it. Its follow-up TODO
// (`smthrs history todo`) files nothing: it waits as a private confirmation
// that only the member's own browser session confirms, once. The member is
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
	forgedDraft := ""
	forged := map[string]string{"Smithers-Via": "browser", "Smithers-Actor": "rehearsal-owner", "Smithers-Profile": "full", "Smithers-Branch": branch1,
		"Smithers-Session": "forged", "X-Forwarded-User": "rehearsal-owner"}
	r.step("13 Forged headers", "T2's terminal credential with forged Smithers-Via, actor, profile, branch and session headers",
		"the same refusals; its TODO draft still waits for the member's Confirm; the request stays delegated via terminal with its own session", "T-ACC-04", func() error {
			if d == nil || d.token == "" {
				return fmt.Errorf("blocked by row 11: no terminal credential")
			}
			seen, err := d.refuse(forged, []refusal{
				{"POST", fmt.Sprintf("/api/todos/%d/merge", t2), `{"reviewed_head_sha":"` + strings.Repeat("a", 40) + `"}`, cannot},
				{"POST", fmt.Sprintf("/api/todos/%d/answer", t1), `{"wait":"q-0123456789abcdef","answer":"x"}`, other},
				{"GET", "/api/install", "", cannot},
			})
			if err != nil {
				return err
			}
			// Its TODO draft still only asks; the member cancels it.
			if forgedDraft, err = d.draft("Forged", "Add a farewell", forged); err != nil {
				return err
			}
			body, err := r.expect("POST", "/api/confirmations/"+forgedDraft+"/deny", "", 200)
			if err != nil {
				return err
			}
			var denied rehearsalConfirmation
			if err = json.Unmarshal(body, &denied); err != nil || denied.State != "rejected" || denied.Card.Receipt == nil || denied.Card.Receipt.Result != "cancelled" {
				return fmt.Errorf("the member's Cancel answered %s", body)
			}
			seen = append(seen, "POST /todos 202 pending, cancelled")
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
	r.step("14 No explicit confirmation", "T2's terminal credential: POST /api/confirmations; approve and deny its own TODO draft's confirmation",
		"403 permission each; no TODO, approval or other change", "T-ACC-04, T-APP-04", func() error {
			if d == nil || d.token == "" {
				return fmt.Errorf("blocked by row 11: no terminal credential")
			}
			if forgedDraft == "" {
				return fmt.Errorf("blocked by row 13: no confirmation")
			}
			before, err := r.stackFacts(t1)
			if err != nil {
				return err
			}
			seen, err := d.refuse(nil, []refusal{
				{"POST", "/api/confirmations", `{"command":"todo.new","subject":{"kind":"todo","ref":"new"},"payload":{}}`, cannot},
				{"POST", "/api/confirmations/" + forgedDraft + "/approve", "", cannot},
				{"POST", "/api/confirmations/" + forgedDraft + "/deny", "", cannot},
			})
			if err != nil {
				return err
			}
			after, err := r.stackFacts(t1)
			if err != nil {
				return err
			}
			r.actual = fmt.Sprintf("%s; %s", strings.Join(seen, ", "), after)
			if before != after {
				return fmt.Errorf("the refused requests changed the stack: %s → %s", before, after)
			}
			return nil
		})
	const followTitle, followPrompt = "Follow-up from Claude Code", "[FILE t3.md] Add a farewell to t3.md"
	confirmation := ""
	r.step("15 Delegated follow-up", "CLAUDECODE=1 smthrs history todo in T2's terminal → POST /api/todos (delegated); GET /api/confirmations",
		"202 {confirmation, state: pending}; one private pending row for the member and no TODO; the member reads its Confirm card asked by Claude Code; the terminal reads only {confirmation, state}; Ben reads nothing and his and the terminal's approve are 403", "T-APP-04", func() error {
			if d == nil || d.token == "" {
				return fmt.Errorf("blocked by row 11: no terminal credential")
			}
			var before int
			if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items`).Scan(&before); err != nil {
				return err
			}
			ran, err := d.term.run(fmt.Sprintf(`CLAUDECODE=1 %q %q history todo %q --body %q --json > "$TMPDIR/j6-todo.json" 2>&1; printf '%%s %%s\n' J6""TODO $?`, node, cli, followTitle, followPrompt),
				regexp.MustCompile(`J6TODO (\d+)`), 2*time.Minute)
			if err != nil {
				return err
			}
			printed, _ := os.ReadFile(filepath.Join(d.tmp, "j6-todo.json"))
			if ran[1] != "0" {
				return fmt.Errorf("smthrs history todo exited %s: %s", ran[1], printed)
			}
			var receipt map[string]any
			if err = json.Unmarshal(printed, &receipt); err != nil {
				return fmt.Errorf("smthrs history todo printed %s: %w", printed, err)
			}
			confirmation, _ = receipt["confirmation"].(string)
			if receipt["state"] != "pending" || confirmation == "" || len(receipt) != 2 {
				return fmt.Errorf("smthrs history todo answered %s, want {confirmation, state: pending}", printed)
			}
			_, own, err := r.confirmations(r.jar, confirmation)
			if err != nil {
				return err
			}
			if own == nil {
				return fmt.Errorf("the member's GET /api/confirmations does not list %s", confirmation)
			}
			status, data, err := d.send("GET", "/api/confirmations", "", nil)
			if err != nil {
				return err
			}
			// The terminal reads the id and state of each confirmation it asked
			// for (row 13's draft too), nothing more.
			var receipts []map[string]any
			_ = json.Unmarshal(data, &receipts)
			terminalReads := ""
			for _, each := range receipts {
				if len(each) != 2 {
					terminalReads = "more than {confirmation, state}"
					break
				}
				if each["confirmation"] == confirmation {
					terminalReads, _ = each["state"].(string)
				}
			}
			ben, err := r.member("ben", 201, "maintain")
			if err != nil {
				return fmt.Errorf("add Ben: %w", err)
			}
			bens, _, err := r.confirmations(ben, confirmation)
			if err != nil {
				return err
			}
			benStatus, benBody, err := r.keyedAs(ben, "POST", "/api/confirmations/"+confirmation+"/approve", "", r.keyPrefix+"ben-approve")
			if err != nil {
				return err
			}
			refused, err := d.refuse(nil, []refusal{{"POST", "/api/confirmations/" + confirmation + "/approve", "", cannot}})
			if err != nil {
				return err
			}
			var after, rows int
			var member string
			if err = r.pool.QueryRow(r.ctx, `SELECT (SELECT count(*) FROM mythical_items),
				(SELECT count(*) FROM approvals WHERE id = $1 AND state = 'pending' AND kind = 'one_click' AND session_id IS NULL AND credential_id IS NOT NULL),
				(SELECT u.username FROM approvals a JOIN users u ON u.id = a.member_id WHERE a.id = $1)`, confirmation).Scan(&after, &rows, &member); err != nil {
				return err
			}
			by := own.Card.AskedBy
			r.actual = fmt.Sprintf("%s; %d pending row for %s; member reads %s %s asked by %s %s for %s session %s; terminal reads %d %s; Ben reads %d, approve %d %s; terminal %s; %d → %d TODOs",
				strings.Join(strings.Fields(string(printed)), " "), rows, member, own.State, own.Card.Kind, by.Kind, by.Agent, by.ForMember.Login, by.SessionID, status, data, len(bens), benStatus, benBody, strings.Join(refused, ", "), before, after)
			switch {
			case rows != 1 || member != "rehearsal-owner":
				return fmt.Errorf("want one pending one_click row for rehearsal-owner's terminal credential, have %d for %q", rows, member)
			case after != before:
				return fmt.Errorf("the draft changed the TODOs: %d → %d", before, after)
			case own.State != "pending" || own.Card.Kind != "one_click" || own.Card.Text != followPrompt:
				return fmt.Errorf("the member's confirmation is %s %s with text %q", own.State, own.Card.Kind, own.Card.Text)
			case by.Kind != "agent" || by.Agent != "claude-code" || by.ForMember.Login != "rehearsal-owner" || by.SessionID != d.session:
				return fmt.Errorf("the confirmation is not asked by Claude Code for rehearsal-owner in session %s", d.session)
			case status != http.StatusOK || terminalReads != "pending":
				return fmt.Errorf("the terminal's GET /api/confirmations answered %d %s, want only its own {confirmation, state}", status, data)
			case len(bens) != 0:
				return fmt.Errorf("Ben reads %d confirmations", len(bens))
			case benStatus != http.StatusForbidden || !strings.Contains(string(benBody), `"code":"permission"`):
				return fmt.Errorf("Ben's approve answered %d %s", benStatus, benBody)
			}
			return nil
		})
	r.step("16 The member confirms", "POST /api/confirmations/{id}/approve from the member's browser session, then again",
		"202 approved; one TODO at the end of the stack, by Claude Code for the member with its session; todo.created by {person, via claude-code, session}; the second press files nothing and answers the same TODO", "T-APP-04", func() error {
			if confirmation == "" {
				return fmt.Errorf("blocked by row 15: no confirmation")
			}
			press := func(key string) (rehearsalConfirmation, error) {
				var pressed rehearsalConfirmation
				status, body, err := r.keyed("POST", "/api/confirmations/"+confirmation+"/approve", "", r.keyPrefix+key)
				if err == nil && status != http.StatusAccepted {
					err = fmt.Errorf("Confirm answered %d %s", status, body)
				}
				if err == nil {
					err = json.Unmarshal(body, &pressed)
				}
				return pressed, err
			}
			first, err := press("confirm-1")
			if err != nil {
				return err
			}
			list, err := r.todoList()
			if err != nil {
				return err
			}
			second, err := press("confirm-2")
			if err != nil {
				return err
			}
			again, err := r.todoList()
			if err != nil {
				return err
			}
			data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", first.Todo), "", 200)
			if err != nil {
				return err
			}
			var card struct {
				Title string `json:"title"`
				Owner struct {
					Login string `json:"login"`
				} `json:"owner"`
				PromptRevisions []struct {
					Text string         `json:"text"`
					By   rehearsalAgent `json:"by"`
				} `json:"prompt_revisions"`
			}
			if err = json.Unmarshal(data, &card); err != nil {
				return err
			}
			var fact []byte
			var asked string
			if err = r.pool.QueryRow(r.ctx, `SELECT data->'by', coalesce(data->>'confirmation', '') FROM product_job_events WHERE event_type = 'todo.created' AND (data->>'n')::bigint = $1`, first.Todo).Scan(&fact, &asked); err != nil {
				return fmt.Errorf("no todo.created fact for T%d: %w", first.Todo, err)
			}
			var factBy map[string]string
			_ = json.Unmarshal(fact, &factBy)
			last := int64(0)
			if len(list) > 0 {
				last = list[len(list)-1].N
			}
			var by rehearsalAgent
			if len(card.PromptRevisions) > 0 {
				by = card.PromptRevisions[0].By
			}
			r.actual = fmt.Sprintf("press 1 %s T%d, press 2 %s T%d; %d then %d TODOs, last T%d %q owner %s; by %s %s for %s session %s; fact by %s confirmation %s",
				first.State, first.Todo, second.State, second.Todo, len(list), len(again), last, card.Title, card.Owner.Login, by.Kind, by.Agent, by.ForMember.Login, by.SessionID, fact, asked)
			switch {
			case first.State != "approved" || first.Todo <= 0 || first.Card.Receipt == nil || first.Card.Receipt.Text != fmt.Sprintf("Committed T%d", first.Todo):
				return fmt.Errorf("Confirm answered %+v", first)
			case second.State != "approved" || second.Todo != first.Todo || len(again) != len(list):
				return fmt.Errorf("the second press filed again: T%d then T%d, %d then %d TODOs", first.Todo, second.Todo, len(list), len(again))
			case last != first.Todo || card.Title != followTitle || card.Owner.Login != "rehearsal-owner" || len(card.PromptRevisions) != 1 || card.PromptRevisions[0].Text != followPrompt:
				return fmt.Errorf("T%d is not the last TODO with the asked title and prompt", first.Todo)
			case by.Kind != "agent" || by.Agent != "claude-code" || by.ForMember.Login != "rehearsal-owner" || by.SessionID != d.session:
				return fmt.Errorf("T%d is not by Claude Code for rehearsal-owner in session %s", first.Todo, d.session)
			case factBy["person"] != "rehearsal-owner" || factBy["via"] != "claude-code" || factBy["session"] != d.session || asked != confirmation:
				return fmt.Errorf("todo.created is not by {rehearsal-owner, claude-code, %s} for confirmation %s", d.session, confirmation)
			}
			return nil
		})
}
