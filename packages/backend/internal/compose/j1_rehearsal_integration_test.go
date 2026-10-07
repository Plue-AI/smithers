package compose

import (
	"encoding/json"
	"fmt"
	"net/http/cookiejar"
	"net/url"
	"slices"
	"strings"
	"testing"
)

// This is an opt-in diagnostic, not a C-J1-04 reference-host passing receipt.
// New orchestration is necessary: isolated setup/TODO tests seed past the journey.
// The composed install and its shared rows are rehearsal_integration_test.go's.
func TestJ1Rehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J1_REHEARSAL", "C-J1-04", "j1-")
	if !r.setupSource() {
		return
	}
	if !r.step("App agent question", "POST "+"/api/conversations/main/prompt", "202; shared answer with file cards after Source ready", "T-INS-06, T-APP-03, T-FLW-01", func() error {
		// Tokens are minted first, so the row's evidence ends on a question.
		chatOnly, err := r.token("write:user")
		if err != nil {
			return err
		}
		reader, err := r.token("write:user", "read:repository")
		if err != nil {
			return err
		}
		creates, live := len(r.compute.Creates()), len(r.compute.Live())
		answer, frames, terminal, err := r.ask("", "What is in JOURNEY.md? Show the file.")
		if err != nil {
			return err
		}
		if !r.sourceReady {
			return fmt.Errorf("Source ready absent before the answer; file-card journey remains blocked")
		}
		fileCard, toolCall := false, false
		for _, frame := range frames {
			toolCall = toolCall || frame.Type == "tool_call"
			if frame.Type == "card" && frame.Card.Kind == "file" && frame.Card.Payload.Path == "JOURNEY.md" {
				// The card holds main's bytes at the mirrored commit.
				if frame.Card.Payload.Content != "Add a greeting to JOURNEY.md\n" || frame.Card.Payload.ReadAt.CommitID != r.mainCommit {
					return fmt.Errorf("file card is not main at %s: %q at %q", r.mainCommit, frame.Card.Payload.Content, frame.Card.Payload.ReadAt.CommitID)
				}
				fileCard = true
			}
		}
		// The answer quotes the file, which only the host's read put in its context.
		if !terminal || !fileCard || toolCall || !strings.Contains(answer, "Add a greeting to JOURNEY.md") {
			return fmt.Errorf("answer/file card missing (terminal=%t file_card=%t renderer_tool_call=%t) answer=%q", terminal, fileCard, toolCall, answer)
		}
		// A path out of the repository is refused, stated and answered; no card.
		answer, frames, terminal, err = r.ask("", "Show ../../etc/passwd")
		if err != nil {
			return err
		}
		for _, frame := range frames {
			if frame.Type == "card" {
				return fmt.Errorf("traversal read rendered a %s card", frame.Card.Kind)
			}
		}
		if !terminal || !strings.Contains(answer, "failed: ../../etc/passwd is not a path inside this repository") {
			return fmt.Errorf("traversal refusal missing (terminal=%t) answer=%q", terminal, answer)
		}
		// Delegated tokens cannot impersonate a person in the shared conversation,
		// even when they carry repository read scopes.
		for _, token := range []string{chatOnly, reader} {
			_, _, _, err := r.ask(token, "What is in JOURNEY.md? Show the file.")
			if err == nil || !strings.Contains(err.Error(), "HTTP 403") {
				return fmt.Errorf("delegated prompt was not refused: %v", err)
			}
		}
		if len(r.compute.Creates()) != creates || len(r.compute.Live()) != live {
			return fmt.Errorf("a question started a machine: creates %d→%d, live %d→%d", creates, len(r.compute.Creates()), live, len(r.compute.Live()))
		}
		return nil
	}) {
		return
	}
	if !r.setupMachine() {
		return
	}
	var number int64
	if !r.step("First TODO", "GET /api/repos/{o}/{r}/mythical; POST /api/todos", "stack active; 202 accepted; positive n; exact app place body", "T-STK-01", func() error {
		if err := r.waitStackActive(); err != nil {
			return err
		}
		data, err := r.expect("POST", "/api/todos", `{"title":"First TODO","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, 202)
		if err != nil {
			return err
		}
		var v struct {
			N     int64  `json:"n"`
			State string `json:"state"`
		}
		if err = json.Unmarshal(data, &v); err != nil {
			return err
		}
		number = v.N
		if number <= 0 || v.State != "accepted" {
			return fmt.Errorf("invalid TODO receipt")
		}
		return nil
	}) {
		return
	}
	todoPath := "/api/todos/{n}"
	if number > 0 {
		todoPath = fmt.Sprintf("/api/todos/%d", number)
	}
	// The app agent reads the stack and one TODO with the TODO cards the
	// person's /todo shows, and proposes a TODO in the shared conversation
	// for its author to confirm. Person-only commands and scoped
	// tokens cannot exercise that authority.
	appAgentTodos := func() error {
		if number <= 0 {
			return fmt.Errorf("blocked by First TODO: no TODO number from public creation receipt")
		}
		count := func() (int, error) {
			data, err := r.expect("GET", "/api/todos", "", 200)
			if err != nil {
				return 0, err
			}
			var todos []struct {
				N int64 `json:"n"`
			}
			err = json.Unmarshal(data, &todos)
			return len(todos), err
		}
		before, err := count()
		if err != nil {
			return err
		}
		ran := func(frames []rehearsalTurnFrame) bool {
			for _, frame := range frames {
				if frame.Type == "card" || frame.Type == "call.started" || frame.Type == "call.settled" || frame.Type == "gate.rejected" {
					return true
				}
			}
			return false
		}
		files := strings.Join([]string{
			"- /files.list [path] [owner/repo] — List a repository directory",
			"- /files.read <path>[:<line>[:<col>]] [owner/repo] [--ref <revision>] — Read a file from a repository",
		}, "\n")
		owned := strings.Join([]string{
			files,
			"- /stack — Show the stack and background runs",
			"- /todo <Tn> — Open a TODO",
			"- /todo.new [text] — Write and place a TODO (asks the person: it only shows them what to confirm, and their press acts)",
		}, "\n")
		// Keep the original commands as the shared catalog gains additional doors.
		answer, _, terminal, err := r.ask("", "What can you run? (instructions)")
		if err != nil {
			return err
		}
		if !terminal {
			return fmt.Errorf("the owner's instructions did not finish")
		}
		for _, command := range strings.Split(owned, "\n") {
			if !slices.Contains(strings.Split(answer, "\n"), command) {
				return fmt.Errorf("the owner's instructions list %q, missing %q", answer, command)
			}
		}
		for _, line := range strings.Split(answer, "\n") {
			for _, name := range []string{"secrets.set", "approval.approve", "approval.deny", "todo.erase"} {
				if strings.HasPrefix(line, "- /"+name+" ") {
					return fmt.Errorf("the agent was offered forbidden command %s", name)
				}
			}
		}
		// /stack: each open TODO as its TODO card; the model reads the rows.
		todoCard := func(frames []rehearsalTurnFrame) bool {
			card := false
			for _, frame := range frames {
				card = card || (frame.Type == "card" && frame.Card.Kind == "todo" && frame.Card.ID == fmt.Sprintf("todo:%d", number) &&
					frame.Card.Payload.N == number && frame.Card.Payload.Model != nil && frame.Card.Payload.Model.Title == "First TODO")
			}
			return card
		}
		answer, frames, terminal, err := r.ask("", "What is on the stack? Run /stack")
		if err != nil {
			return err
		}
		if !terminal || !todoCard(frames) || !strings.Contains(answer, fmt.Sprintf(`{"n":%d,"title":"First TODO"`, number)) {
			return fmt.Errorf("/stack answered no TODO card for T%d: answer=%q", number, answer)
		}
		answer, frames, terminal, err = r.ask("", fmt.Sprintf("Open it. Run /todo T%d", number))
		if err != nil {
			return err
		}
		if !terminal || !todoCard(frames) || !strings.Contains(answer, `"title":"First TODO"`) {
			return fmt.Errorf("/todo T%d answered no TODO card: answer=%q", number, answer)
		}
		// /todo.new requests its author's server confirmation without filing work.
		answer, frames, terminal, err = r.ask("", "Run /todo.new Add a farewell to JOURNEY.md")
		if err != nil {
			return err
		}
		if !terminal || !strings.Contains(answer, `"state":"pending"`) {
			return fmt.Errorf("todo.new did not request confirmation: %q", answer)
		}
		for _, frame := range frames {
			if frame.Type == "card" && frame.Card.Kind == "draft" {
				return fmt.Errorf("private Draft leaked into shared conversation")
			}
		}
		var pending int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals WHERE command='todo.new' AND state='pending'`).Scan(&pending); err != nil {
			return err
		}
		if pending < 1 {
			return fmt.Errorf("missing author confirmation")
		}
		// Merge asks the person and is not the host's; secrets are never the
		// agent's; an unknown command does not exist. None runs anything.
		for _, name := range []string{"approval.approve", "approval.deny", "secrets.set", "todo.erase"} {
			answer, frames, terminal, err = r.ask("", fmt.Sprintf("Run /%s T%d", name, number))
			if err != nil {
				return err
			}
			if !terminal || ran(frames) || !strings.Contains(answer, "unknown-command: "+name) {
				return fmt.Errorf("/%s was not refused: answer=%q", name, answer)
			}
		}
		for _, scopes := range [][]string{{"write:user"}, {"write:user", "read:repository"}} {
			token, err := r.token(scopes...)
			if err != nil {
				return err
			}
			_, _, _, err = r.ask(token, "Run /stack")
			if err == nil || !strings.Contains(err.Error(), "HTTP 403") {
				return fmt.Errorf("delegated stack prompt was not refused: %v", err)
			}
		}
		after, err := count()
		if err != nil {
			return err
		}
		if after != before {
			return fmt.Errorf("the agent filed a TODO: %d TODOs before, %d after", before, after)
		}
		return nil
	}
	head := ""
	var prNumber int64
	for _, state := range []string{"queued", "starting", "working", "in_review"} {
		if !r.step("TODO "+state, "GET "+todoPath, "200 state="+state, "T-STK-01", func() error {
			todo, err := r.waitTodo(number, state)
			if err == nil {
				head, prNumber = todo.PR.Head, todo.PR.Number
			}
			return err
		}) {
			return
		}
	}
	// After the state polls: in_review holds until the merge, so the agent's
	// turns sit inside no transient state's poll window.
	if !r.step("App agent lists TODOs", "POST "+"/api/conversations/main/prompt", "200; /stack and /todo answer TODO cards; /todo.new an author confirmation and no TODO; other commands and tokens refused", "T-APP-16, T-CAT-01", appAgentTodos) {
		return
	}
	if !r.step("PR", "GET GitHub fake /repos/rehearsal-owner/app/pulls/{n}", "head smithers/<slug>; base main; reviewed head", "T-STK-01", func() error {
		_, err := r.checkPull(prNumber, head)
		return err
	}) {
		return
	}
	if !r.step("Merge in Smithers", "POST "+todoPath+"/merge", "202; reviewed head; browser session; one checks.Land", "T-STK-04", func() error {
		return r.merge(number, head)
	}) {
		return
	}
	if !r.step("Merged", "GET "+todoPath+"; GET /api/repos/{o}/{r}/mythical; GET /api/github/sync", "merged only after GitHub merge receipt; the install's main follows GitHub's squash commit; sync fresh", "T-STK-04, T-GH-02", func() error {
		return r.waitMerged(number, prNumber, head)
	}) {
		return
	}
	r.step("8 Members", "POST /api/members; GET /api/auth/github/callback; POST /api/todos; POST /api/todos/{n}/answer; POST /api/todos/{n}/merge; DELETE /api/members/{login}",
		"Ben Maintainer, Alice Member; both sign in; Alice files and answers, cannot merge; Ben may merge; removal ends Alice's session", "T-ACC-02, T-ACC-03", func() error {
			return r.members(number)
		})
}

// members is J1 step 8: the owner adds Ben (a maintainer on GitHub) and Alice
// (write) by username; each signs in with GitHub in their own browser and acts
// by role. Removing Alice refuses her very next request.
func (r *rehearsal) members(first int64) error {
	r.fake.SetCollaborator(201, "ben", "maintain")
	r.fake.SetCollaborator(202, "alice", "write")
	r.fake.SetCollaborator(203, "carol", "read")
	for _, login := range []string{"ben", "alice"} {
		if _, err := r.expect("POST", "/api/members", `{"login":"`+login+`"}`, 204); err != nil {
			return err
		}
	}
	data, err := r.expect("POST", "/api/members", `{"login":"carol"}`, 403)
	if err != nil {
		return err
	}
	if !strings.Contains(string(data), "needs_github_access") {
		return fmt.Errorf("a reader was not refused for GitHub access: %s", data)
	}
	data, err = r.expect("GET", "/api/members", "", 200)
	if err != nil {
		return err
	}
	var roster struct {
		Members []struct{ Login, Role string }
	}
	if err = json.Unmarshal(data, &roster); err != nil {
		return err
	}
	roles := map[string]string{}
	for _, member := range roster.Members {
		roles[member.Login] = member.Role
	}
	if len(roster.Members) != 3 || roles["rehearsal-owner"] != "owner" || roles["ben"] != "maintainer" || roles["alice"] != "member" {
		return fmt.Errorf("roster %v", roles)
	}
	// Each signs in at the install's address with GitHub, in a browser of their own.
	signIn := func(code string, id int64) (*cookiejar.Jar, error) {
		browser, err := cookiejar.New(nil)
		if err != nil {
			return nil, err
		}
		if _, err := r.expectAs(browser, "GET", "/api/auth/github", "", 302); err != nil {
			return nil, err
		}
		start, err := url.Parse(r.location)
		if err != nil {
			return nil, err
		}
		r.fake.SignInAs(code, id)
		if _, err = r.expectAs(browser, "GET", "/api/auth/github/callback?code="+code+"&state="+url.QueryEscape(start.Query().Get("state")), "", 302); err != nil {
			return nil, err
		}
		return browser, nil
	}
	ben, err := signIn("ben-code", 201)
	if err != nil {
		return err
	}
	alice, err := signIn("alice-code", 202)
	if err != nil {
		return err
	}
	// Alice, a Member, files a TODO and answers on it; she cannot merge.
	data, err = r.expectAs(alice, "POST", "/api/todos", `{"title":"Alice's TODO","prompt":"Add a farewell to JOURNEY.md","place":{"mode":"append"}}`, 202)
	if err != nil {
		return err
	}
	var filed struct {
		N int64 `json:"n"`
	}
	if err = json.Unmarshal(data, &filed); err != nil || filed.N <= first {
		return fmt.Errorf("Alice's TODO receipt: %s", data)
	}
	data, err = r.expectAs(alice, "GET", fmt.Sprintf("/api/todos/%d", filed.N), "", 200)
	if err != nil {
		return err
	}
	var card struct {
		Owner struct {
			Login string `json:"login"`
		} `json:"owner"`
	}
	if err = json.Unmarshal(data, &card); err != nil || card.Owner.Login != "alice" {
		return fmt.Errorf("Alice's TODO is not hers: %s", data)
	}
	// Her TODO asks nothing yet: her answer is admitted and finds no question.
	data, err = r.expectAs(alice, "POST", fmt.Sprintf("/api/todos/%d/answer", filed.N), `{"wait":"q-0123456789abcdef","answer":"Use backoff"}`, 404)
	if err != nil {
		return err
	}
	if !strings.Contains(string(data), "wait_not_found") {
		return fmt.Errorf("Alice's answer was not admitted: %s", data)
	}
	merge, _ := json.Marshal(map[string]string{"reviewed_head_sha": strings.Repeat("a", 40)})
	data, err = r.expectAs(alice, "POST", fmt.Sprintf("/api/todos/%d/merge", filed.N), string(merge), 403)
	if err != nil {
		return err
	}
	if !strings.Contains(string(data), `"class":"permission"`) {
		return fmt.Errorf("a Member's merge was not refused by role: %s", data)
	}
	// Ben, a Maintainer, gets past Merge's authorization and approver
	// standing: Alice's TODO is not in review, so the merge waits.
	if _, err = r.expectAs(ben, "POST", fmt.Sprintf("/api/todos/%d/merge", filed.N), string(merge), 409); err != nil {
		return fmt.Errorf("a Maintainer's merge of a TODO not in review: %w", err)
	}
	// Removal ends Alice's session at once.
	if _, err = r.expect("DELETE", "/api/members/alice", "", 204); err != nil {
		return err
	}
	code, _, err := r.keyedAs(alice, "GET", "/api/todos", "", "j1-alice-after-removal")
	if err != nil {
		return err
	}
	if code != 401 && code != 403 {
		return fmt.Errorf("a removed member still reads TODOs: %s", r.actual)
	}
	_, err = r.expectAs(ben, "GET", "/api/members", "", 200)
	return err
}
