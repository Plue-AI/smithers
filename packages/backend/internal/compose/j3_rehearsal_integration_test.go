package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

// j3Branch is what the J3 rows read of a branch:<id> snapshot (spec §14.3
// Branch): the machine, the item, who is there and where, and terminals.
type j3Branch struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	SSHLine string `json:"ssh_line"`
	Machine struct {
		State string `json:"state"`
	} `json:"machine"`
	Item *struct {
		N     int64  `json:"n"`
		State string `json:"state"`
		Step  string `json:"step"`
	} `json:"item"`
	Presence []j3Present `json:"presence"`
}

// j3Present is one person's or agent's row on the Branch card.
type j3Present struct {
	Actor struct {
		Kind      string `json:"kind"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
		Agent     string `json:"agent"`
		RunID     string `json:"run_id"`
		ForMember *struct {
			Login string `json:"login"`
		} `json:"for_member"`
	} `json:"actor"`
	Where struct {
		Kind  string `json:"kind"`
		Path  string `json:"path"`
		Line  int64  `json:"line"`
		Label string `json:"label"`
	} `json:"where"`
	Sessions []json.RawMessage `json:"sessions"`
}

func decodeBranch(frame liveFrame) j3Branch {
	var branch j3Branch
	_ = json.Unmarshal(frame.Data, &branch)
	return branch
}

// people are the person rows of login on the card.
func (b j3Branch) people(login string) []j3Present {
	var rows []j3Present
	for _, row := range b.Presence {
		if row.Actor.Kind == "person" && row.Actor.Login == login {
			rows = append(rows, row)
		}
	}
	return rows
}

// j3Item is what the answer rows read of T2 beyond rehearsalTodo.
type j3Item struct {
	State string `json:"state"`
	Run   *struct {
		ID      string `json:"id"`
		Attempt int    `json:"attempt"`
	} `json:"run"`
	Waits []struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	} `json:"waits"`
	Steers []struct {
		Text string `json:"text"`
		By   struct {
			Kind  string `json:"kind"`
			Login string `json:"login"`
		} `json:"by"`
	} `json:"steers"`
	FirstAnswer *struct {
		Text string `json:"text"`
		By   struct {
			Login string `json:"login"`
		} `json:"by"`
	} `json:"first_answer"`
}

// j3Lane is T2's run and working copy as the stack holds them: the same
// run, attempt and branch must carry the agent through the answer.
type j3Lane struct {
	run, workspace string
	attempt        int32
}

func (r *rehearsal) j3Lane(number int64) (j3Lane, error) {
	var lane j3Lane
	err := r.pool.QueryRow(r.ctx, `SELECT request_run_id, workspace_id, attempt FROM mythical_items WHERE number=$1`, number).Scan(&lane.run, &lane.workspace, &lane.attempt)
	return lane, err
}

// todoEvents are TODO n's activity events of eventType, as GET
// /api/todos/{n}/events serves them (jobs.ReplayPage) to the browser that
// holds jar.
func (r *rehearsal) todoEvents(jar http.CookieJar, number int64, eventType string) ([]map[string]any, error) {
	data, err := r.expectAs(jar, "GET", fmt.Sprintf("/api/todos/%d/events", number), "", 200)
	if err != nil {
		return nil, err
	}
	var page struct {
		Events []struct {
			Type string         `json:"type"`
			Data map[string]any `json:"data"`
		} `json:"events"`
	}
	if err = json.Unmarshal(data, &page); err != nil {
		return nil, err
	}
	var events []map[string]any
	for _, event := range page.Events {
		if event.Type == eventType {
			events = append(events, event.Data)
		}
	}
	return events, nil
}

// settled waits up to within for topic's newest frame to be a snapshot that
// satisfies ok. A refusal on the way is counted, not final: the hub serves
// the topic again once its source builds, and the channel takes that snapshot.
func settled(s *liveSocket, topic string, within time.Duration, ok func(liveFrame) bool) (liveFrame, int, error) {
	for deadline := time.Now().Add(within); ; time.Sleep(100 * time.Millisecond) {
		frames := s.received(topic)
		refusals, last := 0, liveFrame{}
		for _, frame := range frames {
			if frame.T == "err" {
				refusals++
			}
			last = frame
		}
		if last.T == "snap" && ok(last) {
			return last, refusals, nil
		}
		if time.Now().After(deadline) {
			return last, refusals, fmt.Errorf("%s did not settle as wanted within %s: newest frame %q %s, %d refusals", topic, within, last.T, last.Code, refusals)
		}
	}
}

// TestJ3Rehearsal walks journey J3 (mvp.md §5, join a branch; C-J3-01,
// C-J3-05) on the install J1 sets up, as members Ben and Alice on the
// trusted-process runtime. The owner files T2, whose run asks a question
// first and then holds its edit (distribution/fake-todo-turns.mjs [ASK]
// [HOLD t2]). Ben sees T2 in Needs you and opens its branch over /api/live;
// Alice's File card location reaches his Branch card; Ben steers, then
// answers, and the coding agent continues on the same run and working copy.
// Maya's SSH session, the member's own terminal, outside-change activity and
// live co-editing need the machine daemon (smithers-machined), which only a
// microVM runs, so those rows stay pending on lane machined. Ben's
// branch:<id>:activity reads the agent's step and question, his steer and his
// answer.
func TestJ3Rehearsal(t *testing.T) {
	// The model trace keeps each turn's messages: "6 The steer reaches the
	// next model turn" reads the steer and the answer in it.
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, "SMITHERS_J3_REHEARSAL", "C-J3", "j3-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	defer func() { _ = r.release("t2") }()
	const (
		question = "Which greeting should the file carry?"
		steer    = "Keep the max at 5"
		answer   = "Use the existing retry helper"
	)
	var t2 int64
	var ben, alice http.CookieJar
	var benLive *liveSocket
	var before j3Lane
	branch, topic, wait, todoBranch := "", "", "", ""
	if !r.step("1 T2 in Needs you on Ben's Home", "POST /api/todos (owner); members ben, alice; GET /api/live home as Ben", "T2 needs_you with one question; Ben's live Home lists T2 in Needs you", "T-STK-01, T-APP-01, T-ACC-02", func() error {
		var err error
		if t2, err = r.file("T2 retries", "[ASK] [HOLD t2] [FILE retry.ts] Add retries to webhook delivery in retry.ts"); err != nil {
			return err
		}
		if ben, err = r.member("ben", 301, "write"); err != nil {
			return fmt.Errorf("ben: %w", err)
		}
		if alice, err = r.member("alice", 302, "write"); err != nil {
			return fmt.Errorf("alice: %w", err)
		}
		v, err := r.waitTodoWithin(t2, 8*time.Minute, "needs_you")
		if err != nil {
			return err
		}
		if v.Branch == nil || v.Branch.ID == "" || v.Run == nil || v.Run.ID == "" {
			return fmt.Errorf("T%d in Needs you has no branch or run: %s", t2, r.actual)
		}
		if len(v.Waits) != 1 || v.Waits[0].Kind != "question" || v.Waits[0].Prompt != question {
			return fmt.Errorf("T%d's waits are not one question %q: %+v", t2, question, v.Waits)
		}
		branch, topic, wait, todoBranch = v.Branch.ID, "branch:"+v.Branch.ID, v.Waits[0].ID, v.Branch.Name
		if before, err = r.j3Lane(t2); err != nil {
			return err
		}
		if benLive, err = r.openLive(ben); err != nil {
			return err
		}
		if _, err = benLive.subscribe("home"); err != nil {
			return err
		}
		frame, err := benLive.wait("home", 10*time.Second, func(frame liveFrame) bool {
			return slices.ContainsFunc(decodeHome(frame).Items, func(item liveHomeItem) bool { return item.N == t2 && item.State == "needs_you" })
		})
		if err != nil {
			return err
		}
		r.actual = fmt.Sprintf("T%d needs_you on branch %s, run %s; Ben's home cursor %d counts %v", t2, branch, v.Run.ID, *frame.Cursor, decodeHome(frame).Counts)
		return nil
	}) {
		return
	}
	if !r.step("1 Ben opens T2's branch", "GET /api/live branch:<id> as Ben", "the Branch card: T2's branch, item T2 Needs you, machine awake, the SSH line", "T-APP-10, T-COL-06", func() error {
		if _, err := benLive.subscribe(topic); err != nil {
			return err
		}
		frame, err := benLive.wait(topic, 20*time.Second, func(frame liveFrame) bool {
			b := decodeBranch(frame)
			return b.ID == branch && b.Item != nil && b.Item.N == t2
		})
		if err != nil {
			return err
		}
		b := decodeBranch(frame)
		r.actual = fmt.Sprintf("branch %s %q machine=%s item T%d %s; ssh %q; %d present", b.ID, b.Name, b.Machine.State, b.Item.N, b.Item.State, b.SSHLine, len(b.Presence))
		// SSH logs in to smithers/<slug> by its slug (spec §8.10.1).
		login, _ := strings.CutPrefix(b.Name, "smithers/")
		if b.Item.State != "needs_you" || b.Machine.State != "awake" || !strings.HasPrefix(b.SSHLine, "ssh -p 2222 "+login+"@") {
			return fmt.Errorf("the Branch card does not show T%d Needs you on an awake machine with an SSH line", t2)
		}
		return nil
	}) {
		return
	}
	// C-J3-01's setup: a working TODO's branch is smithers/<slug> on both
	// cards, and the Branch card's SSH line logs in to it by its slug.
	r.step("1 The Branch card names T2's branch", "GET /api/todos/{T2}; Ben's branch:<id>", "both cards name smithers/<slug>; the SSH line is ssh -p 2222 <slug>@<host>", "T-APP-10, T-STK-01", func() error {
		frame, err := benLive.latest(topic, 5*time.Second, func(frame liveFrame) bool { return decodeBranch(frame).ID == branch })
		if err != nil {
			return err
		}
		b := decodeBranch(frame)
		r.actual = fmt.Sprintf("TODO card %q; Branch card %q; %q", todoBranch, b.Name, b.SSHLine)
		slug, named := strings.CutPrefix(todoBranch, "smithers/")
		if !named || slug == "" || b.Name != todoBranch || !strings.HasPrefix(b.SSHLine, "ssh -p 2222 "+slug+"@") {
			return fmt.Errorf("T%d's branch is not smithers/<slug> on both cards with its SSH line", t2)
		}
		return nil
	})
	var aliceTab, aliceSecondTab *liveSocket
	defer func() {
		for _, tab := range []*liveSocket{aliceTab, aliceSecondTab} {
			if tab != nil {
				tab.stop()
			}
		}
	}()
	// atFile is Alice's row at path:line on Ben's card, with sessions tabs.
	atFile := func(path string, line int64, sessions int) func(liveFrame) bool {
		return func(frame liveFrame) bool {
			rows := decodeBranch(frame).people("alice")
			return len(rows) == 1 && rows[0].Where.Kind == "file" && rows[0].Where.Path == path && rows[0].Where.Line == line && len(rows[0].Sessions) == sessions
		}
	}
	r.step("2 Alice in the File card at retry.ts:12", "Alice's /api/live presence {branch, path, line} → Ben's branch:<id>", "one Alice row, a person with her avatar, at retry.ts:12 within 1 s", "T-COL-06, T-APP-10", func() error {
		var err error
		if aliceTab, err = r.openLive(alice); err != nil {
			return err
		}
		// The File card's reader follows the branch before it announces.
		if _, err = aliceTab.subscribe(topic); err != nil {
			return err
		}
		if _, err = aliceTab.wait(topic, 20*time.Second, func(frame liveFrame) bool { return decodeBranch(frame).ID == branch }); err != nil {
			return fmt.Errorf("Alice's branch topic: %w", err)
		}
		sent := time.Now()
		if err = aliceTab.presence(map[string]any{"branch": branch, "path": "retry.ts", "line": 12}); err != nil {
			return err
		}
		frame, err := benLive.wait(topic, 10*time.Second, atFile("retry.ts", 12, 1))
		if err != nil {
			return err
		}
		took := frame.At.Sub(sent)
		row := decodeBranch(frame).people("alice")[0]
		r.actual = fmt.Sprintf("Alice (%s, %s) at %s:%d after %dms", row.Actor.Name, row.Actor.AvatarURL, row.Where.Path, row.Where.Line, took.Milliseconds())
		if row.Actor.AvatarURL == "" || row.Actor.Name == "" {
			return fmt.Errorf("Alice's row has no name or avatar")
		}
		if took > time.Second {
			return fmt.Errorf("Alice's location reached Ben after %s, want within 1 s", took)
		}
		return nil
	})
	r.step("2 One row per person across tabs", "a second Alice tab at retry.ts:40; close it", "still one Alice row (two sessions) at the newest location; one session after the tab closes", "T-COL-06", func() error {
		if aliceTab == nil {
			return fmt.Errorf("blocked by Alice in the File card")
		}
		var err error
		if aliceSecondTab, err = r.openLive(alice); err != nil {
			return err
		}
		if _, err = aliceSecondTab.subscribe(topic); err != nil {
			return err
		}
		if _, err = aliceSecondTab.wait(topic, 20*time.Second, func(frame liveFrame) bool { return decodeBranch(frame).ID == branch }); err != nil {
			return err
		}
		if err = aliceSecondTab.presence(map[string]any{"branch": branch, "path": "retry.ts", "line": 40}); err != nil {
			return err
		}
		if _, err = benLive.latest(topic, 10*time.Second, atFile("retry.ts", 40, 2)); err != nil {
			return fmt.Errorf("two tabs: %w", err)
		}
		aliceSecondTab.stop()
		aliceSecondTab = nil
		if _, err = benLive.latest(topic, 10*time.Second, atFile("retry.ts", 12, 1)); err != nil {
			return fmt.Errorf("after the second tab closed: %w", err)
		}
		r.actual = "one Alice row at retry.ts:40 with 2 sessions; back to retry.ts:12 with 1 session after the tab closed"
		return nil
	})
	r.pending("2 Maya via SSH at retry.ts", "ssh -p 2222 <branch>@<host>; edit and save retry.ts", "Ben's card shows \"Maya via SSH\" at retry.ts (needs smithers-machined; not provable on trusted-process)", "T-TRM-03, T-COL-06", "machined")
	r.pending("2 Maya's saves in open cards", "Maya saves retry.ts over SSH → branch:<id>:files", "the File card shows the new text with last writer \"Maya via SSH\" (needs smithers-machined)", "T-COL-04, T-COL-12", "machined")
	r.pending("3 Ben's own terminal; Alice watches", "POST /api/terminals {branch}; terminal WebSocket as Ben, then Alice", "Ben's terminal runs as ben on the branch; Alice sees it on the card and watches; her keys are dropped (owner PTYs need smithers-machined)", "T-TRM-01, T-APP-12", "machined")
	r.pending("4 Maya via SSH changed 12 files", "pnpm format over SSH → branch:<id>:activity", "one entry \"Maya via SSH changed 12 files\" with its diff; open cards update in place (needs smithers-machined)", "T-COL-04, T-TRM-03", "machined")
	r.pending("5 Ben and Alice co-edit retry.ts", "doc:code topic from both browsers", "each sees the other's characters live with a name flag; the file is saved to the machine continuously (needs smithers-machined)", "T-COL-08, T-APP-14", "machined")
	r.step("2 Alice leaves", "close Alice's last tab", "her row leaves Ben's card within 1 s", "T-COL-06", func() error {
		if aliceTab == nil {
			return fmt.Errorf("blocked by Alice in the File card")
		}
		closed := time.Now()
		aliceTab.stop()
		aliceTab = nil
		frame, err := benLive.latest(topic, 10*time.Second, func(frame liveFrame) bool { return len(decodeBranch(frame).people("alice")) == 0 })
		if err != nil {
			return err
		}
		took := frame.At.Sub(closed)
		r.actual = fmt.Sprintf("Alice's row gone %dms after her tab closed", took.Milliseconds())
		if took > time.Second {
			return fmt.Errorf("Alice's row lingered %s after her tab closed, want within 1 s", took)
		}
		return nil
	})
	todoPath := fmt.Sprintf("/api/todos/%d", t2)
	read := func(jar http.CookieJar) (j3Item, error) {
		var v j3Item
		data, err := r.expectAs(jar, "GET", todoPath, "", 200)
		if err == nil {
			err = json.Unmarshal(data, &v)
		}
		return v, err
	}
	r.step("6 Answer the coding agent", "GET "+todoPath+" as Ben; Ben's branch:<id>", "the branch's item is Needs you; its one question offers Answer (todo.answer)", "T-APP-10, T-STK-06", func() error {
		v, err := r.todo(t2)
		if err != nil {
			return err
		}
		answerable := false
		for _, w := range v.Waits {
			for _, action := range w.Actions {
				answerable = answerable || len(v.Waits) == 1 && w.ID == wait && action.Tag == "todo.answer"
			}
		}
		frame, err := benLive.latest(topic, 5*time.Second, func(frame liveFrame) bool {
			b := decodeBranch(frame)
			return b.Item != nil && b.Item.State == "needs_you"
		})
		if err != nil {
			return err
		}
		r.actual = fmt.Sprintf("T%d %s; wait %s answerable=%t; branch item %s", t2, v.State, wait, answerable, decodeBranch(frame).Item.State)
		if !answerable {
			return fmt.Errorf("T%d's question offers no Answer: %+v", t2, v.Waits)
		}
		return nil
	})
	r.step("6 A steer leaves the question open", "POST "+todoPath+" {op: steer, text} as Ben ×2", "202 within 1 s, again 202; one steer by Ben; T2 still Needs you with the same question; one todo.steer_received by Ben", "T-STK-06", func() error {
		body, _ := json.Marshal(map[string]string{"op": "steer", "text": steer})
		for press := range 2 {
			began := time.Now()
			code, data, err := r.keyedAs(ben, "POST", todoPath, string(body), r.keyPrefix+"steer-t2")
			if err != nil {
				return err
			}
			if code != 202 || !strings.Contains(string(data), `"accepted"`) {
				return fmt.Errorf("steer press %d: %s", press+1, r.actual)
			}
			if took := time.Since(began); took > time.Second {
				return fmt.Errorf("steer press %d answered in %s, want within 1 s", press+1, took)
			}
		}
		v, err := read(ben)
		if err != nil {
			return err
		}
		if len(v.Steers) != 1 || v.Steers[0].Text != steer || v.Steers[0].By.Login != "ben" {
			return fmt.Errorf("steers %+v, want one by Ben: %q", v.Steers, steer)
		}
		if v.State != "needs_you" || len(v.Waits) != 1 || v.Waits[0].ID != wait {
			return fmt.Errorf("the steer settled the question: state %s waits %+v", v.State, v.Waits)
		}
		events, err := r.todoEvents(ben, t2, "todo.steer_received")
		if err != nil {
			return err
		}
		if len(events) != 1 || fmt.Sprint(events[0]["text"]) != steer || !strings.Contains(fmt.Sprint(events[0]["by"]), "ben") {
			return fmt.Errorf("todo.steer_received events %v, want one by Ben", events)
		}
		r.actual = fmt.Sprintf("202 ×2; steers [%q by %s]; T%d %s, wait %s open; 1 todo.steer_received", v.Steers[0].Text, v.Steers[0].By.Login, t2, v.State, wait)
		return nil
	})
	if !r.step("6 Ben's answer settles the question", "POST "+todoPath+"/answer as Ben ×2, then as Alice", "202, again 202; Alice's 409 names Ben; no open wait; first_answer by Ben; one todo.answered by Ben", "T-STK-06, T-APP-10", func() error {
		body := func(text string) string {
			data, _ := json.Marshal(map[string]string{"wait": wait, "answer": text})
			return string(data)
		}
		for press, want := range []struct {
			jar    http.CookieJar
			text   string
			status int
		}{{ben, answer, 202}, {ben, answer, 202}, {alice, "Write a new helper", 409}} {
			code, data, err := r.keyedAs(want.jar, "POST", todoPath+"/answer", body(want.text), fmt.Sprintf("%sanswer-%d", r.keyPrefix, press))
			if err != nil {
				return err
			}
			if code != want.status || want.status == 409 && !strings.Contains(string(data), `"answered_by":"ben"`) {
				return fmt.Errorf("answer %d: expected HTTP %d: %s", press+1, want.status, r.actual)
			}
		}
		v, err := read(ben)
		if err != nil {
			return err
		}
		if len(v.Waits) != 0 || v.FirstAnswer == nil || v.FirstAnswer.Text != answer || v.FirstAnswer.By.Login != "ben" {
			return fmt.Errorf("the answer did not settle the question as Ben's: state %s waits %+v first_answer %+v", v.State, v.Waits, v.FirstAnswer)
		}
		events, err := r.todoEvents(ben, t2, "todo.answered")
		if err != nil {
			return err
		}
		if len(events) != 1 || !strings.Contains(fmt.Sprint(events[0]["actor"]), "login:ben") {
			return fmt.Errorf("todo.answered events %v, want one by Ben", events)
		}
		r.actual = fmt.Sprintf("202 ×2; Alice 409 answered_by ben; T%d %s; first_answer %q by %s; 1 todo.answered", t2, v.State, v.FirstAnswer.Text, v.FirstAnswer.By.Login)
		return nil
	}) {
		return
	}
	r.step("6 The steer and the answer in the branch activity", "Ben's branch:<id>:activity", "the coding agent's step and its question, then a Steer entry by Ben, then the answer settling the question with his avatar", "T-APP-10, T-STK-06", func() error {
		activity := topic + ":activity"
		if _, err := benLive.subscribe(activity); err != nil {
			return err
		}
		type entry struct {
			Kind  string `json:"kind"`
			Text  string `json:"text"`
			Files *int   `json:"files"`
			Actor struct {
				Kind      string `json:"kind"`
				Login     string `json:"login"`
				AvatarURL string `json:"avatar_url"`
				Agent     string `json:"agent"`
				RunID     string `json:"run_id"`
			} `json:"actor"`
		}
		var entries []entry
		find := func(kind, text string) int {
			return slices.IndexFunc(entries, func(e entry) bool { return e.Kind == kind && (text == "" || e.Text == text) })
		}
		_, err := benLive.wait(activity, 20*time.Second, func(frame liveFrame) bool {
			entries = nil
			return json.Unmarshal(frame.Data, &entries) == nil && find("answer", answer) >= 0
		})
		var kinds []string
		for _, e := range entries {
			kinds = append(kinds, e.Kind+" by "+e.Actor.Login+e.Actor.Agent)
		}
		r.actual = fmt.Sprintf("%d entries: %s", len(entries), strings.Join(kinds, ", "))
		if err != nil {
			return err
		}
		step, asked, steered, answered := find("step", ""), find("question", question), find("steer", steer), find("answer", answer)
		agentOn := func(i int) bool {
			return i >= 0 && entries[i].Actor.Kind == "agent" && entries[i].Actor.Agent == "coding" && entries[i].Actor.RunID == before.run
		}
		benOn := func(i int) bool {
			return i >= 0 && entries[i].Actor.Kind == "person" && entries[i].Actor.Login == "ben" && entries[i].Actor.AvatarURL != "" && entries[i].Files == nil
		}
		switch {
		case !agentOn(step) || !agentOn(asked):
			return fmt.Errorf("the coding agent's step and question are not on run %s", before.run)
		case !benOn(steered) || !benOn(answered):
			return fmt.Errorf("the steer and the answer are not Ben's with his avatar")
		case !(step < asked && asked < steered && steered < answered):
			return fmt.Errorf("entries out of order: step %d, question %d, steer %d, answer %d", step, asked, steered, answered)
		}
		return nil
	})
	r.step("6 The agent continues on the same working copy", "model trace; GET "+todoPath+"; SQL mythical_items; Ben's branch:<id>", "the plan after the answer carries it; T2 Working, held at its edit, on the same run, attempt and branch; the coding agent is on Ben's card at its step", "T-STK-06, T-COL-06", func() error {
		if err := r.waitHeld("t2", 5*time.Minute); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(t2, time.Minute, "working")
		if err != nil {
			return err
		}
		after, err := r.j3Lane(t2)
		if err != nil {
			return err
		}
		if after != before || v.Branch == nil || v.Branch.ID != branch || v.Run == nil || v.Run.ID != before.run {
			return fmt.Errorf("T%d moved off its run or working copy: before %+v, after %+v (card run %+v)", t2, before, after, v.Run)
		}
		turns, err := r.modelTurns()
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(turns, func(turn map[string]any) bool {
			return turn["step"] == "coding/draft-plan" && strings.Contains(turnText(turn), answer)
		}) {
			return fmt.Errorf("no plan turn carries the answer (%d turns)", len(turns))
		}
		frame, refusals, err := settled(benLive, topic, 30*time.Second, func(frame liveFrame) bool {
			return slices.ContainsFunc(decodeBranch(frame).Presence, func(row j3Present) bool {
				return row.Actor.Kind == "agent" && row.Actor.RunID == before.run && row.Where.Kind == "step" && row.Where.Label != ""
			})
		})
		agent := "no agent row"
		if frame.Data != nil {
			for _, row := range decodeBranch(frame).Presence {
				if row.Actor.Kind == "agent" {
					forMember := ""
					if row.Actor.ForMember != nil {
						forMember = row.Actor.ForMember.Login
					}
					agent = fmt.Sprintf("%s agent %q for %s at step %q", row.Actor.Agent, row.Actor.Name, forMember, row.Where.Label)
				}
			}
		}
		r.actual = fmt.Sprintf("T%d working, held at its edit, on run %s attempt %d, branch %s; the plan carries the answer; %s; %d branch refusals", t2, after.run, after.attempt, after.workspace, agent, refusals)
		return err
	})
	r.step("6 The steer reaches the next model turn", "model trace (TRACE_MESSAGES=1)", "the first model turn after the answer carries the steer committed before it (spec §10.7.3)", "T-STK-06", func() error {
		turns, err := r.modelTurns()
		if err != nil {
			return err
		}
		next := slices.IndexFunc(turns, func(turn map[string]any) bool { return strings.Contains(turnText(turn), answer) })
		if next < 0 {
			return fmt.Errorf("blocked by The agent continues: no model turn carries the answer (%d turns)", len(turns))
		}
		if strings.Contains(turnText(turns[next]), steer) {
			r.actual = fmt.Sprintf("turn %d (%v) carries the answer and the steer", next+1, turns[next]["step"])
			return nil
		}
		late := slices.IndexFunc(turns, func(turn map[string]any) bool { return strings.Contains(turnText(turn), steer) })
		if late < 0 {
			return fmt.Errorf("no model turn carries the steer; turn %d (%v) carries only the answer", next+1, turns[next]["step"])
		}
		return fmt.Errorf("turn %d (%v) carries only the answer; the steer arrives at turn %d (%v), a follow-up after its cell finished", next+1, turns[next]["step"], late+1, turns[late]["step"])
	})
	r.step("6 The edit lands on T2's branch", "release [HOLD t2]; GET "+todoPath+"; GitHub fake PR", "T2 in review on the same run and attempt; its PR head's retry.ts carries the answer", "T-STK-01, T-STK-06", func() error {
		if err := r.release("t2"); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(t2, 5*time.Minute, "in_review")
		if err != nil {
			// The edit's own tool result says why its write was refused.
			if turns, traceErr := r.modelTurns(); traceErr == nil {
				for i := len(turns) - 1; i >= 0; i-- {
					text := turnText(turns[i])
					if at := strings.LastIndex(text, "Flow write failed: "); at >= 0 {
						refusal, _, _ := strings.Cut(text[at:], "\n")
						return fmt.Errorf("%w; the edit's write was refused: %s", err, refusal)
					}
				}
			}
			return err
		}
		p, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		after, err := r.j3Lane(t2)
		if err != nil {
			return err
		}
		if after.run != before.run || after.attempt != before.attempt {
			return fmt.Errorf("T%d reached review on run %s attempt %d, want %s attempt %d", t2, after.run, after.attempt, before.run, before.attempt)
		}
		retry, err := r.githubGit("show", p.Head.SHA+":retry.ts")
		if err != nil {
			return err
		}
		r.actual = fmt.Sprintf("in_review on run %s attempt %d; PR #%d %s retry.ts %q", after.run, after.attempt, p.Number, p.Head.Ref, retry)
		if !strings.Contains(retry, answer) {
			return fmt.Errorf("the PR head's retry.ts does not carry the answer")
		}
		return nil
	})
}
