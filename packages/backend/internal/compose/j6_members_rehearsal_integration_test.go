package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Ben signs in through GitHub and uses the same branch terminal door as the
// owner. His guest credential never substitutes for his browser at Confirm.
func (r *rehearsal) benTerminalRows(branch string) {
	var ben http.CookieJar
	var d *delegatedTerminal
	var id string
	var before []rehearsalTodo
	defer func() {
		if d != nil && d.term != nil {
			d.term.close()
		}
	}()
	if !r.step("17 Ben's branch terminal", "GitHub sign-in; POST /api/terminals as Ben and as non-member", "Ben's terminal runs as Ben's uid; unauthenticated request creates no terminal", "T-ACC-02, T-TRM-01", func() error {
		var err error
		ben, err = r.member("ben", 7002, "maintain")
		if err != nil {
			return err
		}
		send := func(method, path, body, key string) (int, []byte, error) {
			return r.keyedAs(ben, method, path, body, key)
		}
		session, err := r.openBranchTerminal(send, branch)
		if err != nil {
			return err
		}
		term, err := r.openTerminalAs(ben, session)
		if err != nil {
			return err
		}
		d = &delegatedTerminal{r: r, term: term, session: session}
		match, err := term.run(`printf '%s %s\n' J6""BEN "$(id -u)"`, regexp.MustCompile(`J6BEN (\d+)`), 30*time.Second)
		if err != nil {
			return err
		}
		var uid string
		if err = r.pool.QueryRow(r.ctx, `SELECT c.unix_uid::text FROM collaborators c JOIN users u ON u.id=c.user_id WHERE u.lower_username='ben'`).Scan(&uid); err != nil {
			return err
		}
		if match[1] != uid {
			return fmt.Errorf("Ben terminal uid %s, want %s", match[1], uid)
		}
		read, err := term.run(`printf '%s %s\n' J6""TOKEN "$(cat "$SMITHERS_TOKEN_FILE")"`, regexp.MustCompile(`J6TOKEN (\S+)`), 30*time.Second)
		if err != nil {
			return err
		}
		d.token = read[1]
		var count int
		if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'terminal.%'`).Scan(&count); err != nil {
			return err
		}
		stranger, _ := cookiejar.New(nil)
		body, _ := json.Marshal(map[string]string{"branch": branch})
		status, raw, err := r.keyedAs(stranger, "POST", "/api/terminals", string(body), uuid.NewString())
		if err != nil {
			return err
		}
		if status != 401 {
			return fmt.Errorf("non-member terminal answered %d %s, want 401", status, raw)
		}
		var after int
		if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'terminal.%'`).Scan(&after); err != nil {
			return err
		}
		if count != after {
			return fmt.Errorf("non-member created terminal facts")
		}
		r.actual = "Ben's owner-uid terminal running; non-member 401 without effects"
		return nil
	}) {
		return
	}
	if !r.step("15 Delegated follow-up", "Ben's terminal POST /api/todos; private confirmation reads and decisions", "202 one private Confirm for Ben; no TODO; other person and delegated decisions refuse", "T-APP-04", func() error {
		var err error
		before, err = r.todoList()
		if err != nil {
			return err
		}
		var approvals int
		if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals`).Scan(&approvals); err != nil {
			return err
		}
		status, envelope, err := d.call("POST", "/api/todos", `{"title":"Ben follow-up","prompt":"[HOLD ben-followup] [FILE followup.md] Add a farewell","place":{"mode":"append"}}`, nil)
		if err != nil {
			return err
		}
		id, _ = envelope["confirmation"].(string)
		if status != 202 || id == "" || envelope["state"] != "pending" {
			return fmt.Errorf("draft answered %d %v", status, envelope)
		}
		var afterApprovals int
		if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals`).Scan(&afterApprovals); err != nil {
			return err
		}
		if afterApprovals != approvals+1 {
			return fmt.Errorf("draft made %d confirmations", afterApprovals-approvals)
		}
		after, err := r.todoList()
		if err != nil {
			return err
		}
		if len(after) != len(before) {
			return fmt.Errorf("draft created TODO")
		}
		for _, viewer := range []struct {
			jar  http.CookieJar
			sees bool
		}{{ben, true}, {r.jar, false}} {
			raw, err := r.expectAs(viewer.jar, "GET", "/api/confirmations", "", 200)
			if err != nil {
				return err
			}
			if strings.Contains(string(raw), id) != viewer.sees {
				return fmt.Errorf("confirmation privacy mismatch")
			}
		}
		if _, err = r.expect("POST", "/api/confirmations/"+id+"/approve", `{}`, 403); err != nil {
			return err
		}
		status, envelope, err = d.call("POST", "/api/confirmations/"+id+"/approve", `{}`, nil)
		if err != nil {
			return err
		}
		if status != 403 || envelope["class"] != "permission" {
			return fmt.Errorf("delegated approve answered %d %v", status, envelope)
		}
		return nil
	}) {
		return
	}
	defer func() { _ = r.release("ben-followup") }()
	r.step("16 Ben confirms", "POST /api/confirmations/{id}/approve twice as Ben", "exactly one TODO at stack end attributed to Claude Code for Ben", "T-APP-04", func() error {
		key := uuid.NewString()
		for range 2 {
			status, raw, err := r.keyedAs(ben, "POST", "/api/confirmations/"+id+"/approve", `{}`, key)
			if err != nil {
				return err
			}
			if status != 200 {
				return fmt.Errorf("Confirm answered %d %s", status, raw)
			}
		}
		after, err := r.todoList()
		if err != nil {
			return err
		}
		if len(after) != len(before)+1 {
			return fmt.Errorf("Confirm made %d TODOs", len(after)-len(before))
		}
		var n int64
		for _, todo := range after {
			if todo.Title == "Ben follow-up" {
				n = todo.N
			}
		}
		if n == 0 || after[len(after)-1].N != n {
			return fmt.Errorf("follow-up is not last")
		}
		raw, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", n), "", 200)
		if err != nil {
			return err
		}
		var card struct {
			Revisions []struct {
				By struct{ Login string } `json:"by"`
			} `json:"revisions"`
		}
		if err = json.Unmarshal(raw, &card); err != nil {
			return err
		}
		if len(card.Revisions) != 1 || card.Revisions[0].By.Login != "ben" {
			return fmt.Errorf("confirmed TODO revision is not Ben's: %s", raw)
		}
		var actor []byte
		if err = r.pool.QueryRow(r.ctx, `SELECT payload->'card'->'asked_by' FROM approvals WHERE id=$1`, id).Scan(&actor); err != nil {
			return err
		}
		var asked struct {
			Kind, Agent string
			ForMember   struct{ Login string } `json:"for_member"`
			Session     string                 `json:"session_id"`
		}
		if err = json.Unmarshal(actor, &asked); err != nil {
			return err
		}
		if asked.Kind != "agent" || asked.Agent != "claude-code" || asked.ForMember.Login != "ben" || asked.Session != d.session {
			return fmt.Errorf("follow-up lost delegated actor: %s", actor)
		}
		r.actual = fmt.Sprintf("T%d last; two presses, one TODO; actor %s", n, actor)
		return nil
	})
}
