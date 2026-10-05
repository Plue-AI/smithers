package compose

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
)

// j4Card is what the retry rows read of GET /api/todos/{n} beyond
// rehearsalTodo: the failure, the steers and each attempt's evidence.
type j4Card struct {
	State string `json:"state"`
	Run   *struct {
		ID      string `json:"id"`
		Attempt int32  `json:"attempt"`
	} `json:"run"`
	Failure *struct {
		Step      string `json:"step"`
		Class     string `json:"class"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	} `json:"failure"`
	Steers []struct {
		Text string `json:"text"`
		By   struct {
			Kind  string `json:"kind"`
			Login string `json:"login"`
		} `json:"by"`
		At string `json:"at"`
	} `json:"steers"`
	Evidence []j4Evidence `json:"evidence"`
}

// j4Evidence is one attempt's evidence on the card.
type j4Evidence struct {
	Attempt int32            `json:"attempt"`
	Items   []map[string]any `json:"items"`
}

// recordedEvidence is an attempt's recorded evidence items: the card reads
// model access live for the current attempt only, so it is left out.
func recordedEvidence(items []map[string]any) []map[string]any {
	return slices.DeleteFunc(slices.Clone(items), func(item map[string]any) bool { return item["kind"] == "model_access" })
}

// attemptsOf is TODO n's stored evidence per attempt (checks.attempts).
func (r *rehearsal) attemptsOf(number int64) ([]j4Evidence, error) {
	var raw []byte
	if err := r.pool.QueryRow(r.ctx, `SELECT coalesce(checks->'attempts', '[]'::jsonb) FROM mythical_items WHERE number=$1`, number).Scan(&raw); err != nil {
		return nil, err
	}
	var attempts []j4Evidence
	return attempts, json.Unmarshal(raw, &attempts)
}

func (r *rehearsal) j4Card(number int64) (j4Card, error) {
	var card j4Card
	data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	if err == nil {
		err = json.Unmarshal(data, &card)
	}
	return card, err
}

// modelTurns are the scripted model's traced turns (TRACE_MESSAGES=1 keeps
// each message's text), in the order it served them.
func (r *rehearsal) modelTurns() ([]map[string]any, error) {
	file, err := os.Open(filepath.Join(r.evidence, "model-turns.jsonl"))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var turns []map[string]any
	lines := bufio.NewScanner(file)
	lines.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for lines.Scan() {
		var turn map[string]any
		if json.Unmarshal(lines.Bytes(), &turn) == nil {
			turns = append(turns, turn)
		}
	}
	return turns, lines.Err()
}

// turnText is every traced message of a turn, joined.
func turnText(turn map[string]any) string {
	var b strings.Builder
	messages, _ := turn["all"].([]any)
	for _, message := range messages {
		if m, ok := message.(map[string]any); ok {
			b.WriteString(fmt.Sprint(m["content"]) + "\n")
		}
	}
	return b.String()
}

// TestJ4Rehearsal walks journey J4 (mvp.md §5, the team's work; C-J4-01..03)
// as the owner on the install J1 sets up. T1 goes straight to review, T2
// asks a question and T3 fails its checks (distribution/fake-todo-turns.mjs
// markers). The owner answers T2 and merges T1 while chatting; T4, filed
// once T3 failed, is the ready item a person moves above T3. Rows that wait
// on a lane are listed as pending.
func TestJ4Rehearsal(t *testing.T) {
	// The model trace keeps each turn's messages: row 14b reads the steer in
	// the first turn of T3's retried attempt.
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, "SMITHERS_J4_REHEARSAL", "C-J4", "j4-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	var t1, t2, t3, t4 int64
	head1, wait2 := "", ""
	var pr1 int64
	const answer2 = "Say hello in French"
	if !r.step("1 File T1-T3", "POST /api/todos ×3", "202 ×3 with distinct numbers", "T-STK-01", func() error {
		for _, todo := range []struct {
			n             *int64
			title, prompt string
		}{
			{&t1, "T1 ready", "[PR] [FILE t1.md] Add a greeting to t1.md"},
			{&t2, "T2 asks", "[ASK] [FILE t2.md] Add a greeting to t2.md"},
			{&t3, "T3 fails", "[FAIL] [FILE t3.md] Add a greeting to t3.md"},
		} {
			n, err := r.file(todo.title, todo.prompt)
			if err != nil {
				return err
			}
			*todo.n = n
		}
		if t1 == t2 || t2 == t3 || t1 == t3 {
			return fmt.Errorf("TODO numbers repeat: %d %d %d", t1, t2, t3)
		}
		r.actual = fmt.Sprintf("202 T%d T%d T%d", t1, t2, t3)
		return nil
	}) {
		return
	}
	// The owner's browser follows Home and the three TODOs over /api/live
	// from here on; rows 5, 5b and 15 read what it received.
	owner, liveErr := r.openLive(r.jar)
	if liveErr == nil {
		for _, topic := range []string{"home", fmt.Sprintf("todo:%d", t1), fmt.Sprintf("todo:%d", t2), fmt.Sprintf("todo:%d", t3)} {
			if _, liveErr = owner.subscribe(topic); liveErr != nil {
				break
			}
		}
	}
	if !r.step("2 T1 in review", "GET /api/todos/{T1}; GitHub fake PR", "in_review; PR smithers/<slug> at the card's head, base main, not a draft", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t1, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		p, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		if p.Draft {
			return fmt.Errorf("T1, first on the stack, has a draft PR")
		}
		head1, pr1 = v.PR.Head, v.PR.Number
		return nil
	}) {
		return
	}
	if !r.step("3 T2 needs you", "GET /api/todos/{T2}", "needs_you; one open question with Answer", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t2, 8*time.Minute, "needs_you")
		if err != nil {
			return err
		}
		answerable := false
		for _, wait := range v.Waits {
			for _, action := range wait.Actions {
				answerable = answerable || action.Tag == "todo.answer"
			}
		}
		if len(v.Waits) != 1 || v.Waits[0].Kind != "question" || v.Waits[0].Prompt != "Which greeting should the file carry?" || !answerable {
			return fmt.Errorf("T2's waits are not one question with Answer: %+v", v.Waits)
		}
		wait2 = v.Waits[0].ID
		return nil
	}) {
		return
	}
	if !r.step("4 T1 and T2 on their own branch machines", "GET /api/todos/{T1}; GET /api/todos/{T2}", "each has a branch; the branch ids differ", "T-MCH-04, T-STK-01", func() error {
		var branches []string
		for _, n := range []int64{t1, t2} {
			v, err := r.todo(n)
			if err != nil {
				return err
			}
			if v.Branch == nil || v.Branch.ID == "" {
				return fmt.Errorf("T%d has no branch", n)
			}
			branches = append(branches, v.Branch.ID)
		}
		if branches[0] == branches[1] {
			return fmt.Errorf("T%d and T%d share branch %s", t1, t2, branches[0])
		}
		r.actual = fmt.Sprintf("200 T%d branch %s; T%d branch %s", t1, branches[0], t2, branches[1])
		return nil
	}) {
		return
	}
	// Rows 5 and 6 are the served half of the Home card (lane home-role, which
	// landed its app half in eee936060f).
	r.step("5 Home rows and counts", "GET /api/live (home); SQL mythical_items", "each unmerged TODO once, in place order; their count equals the stack's unmerged items", "T-APP-01", func() error {
		if liveErr != nil {
			return liveErr
		}
		// mythical_items has no merged_at or dropped_at (C-J4-01's SQL): an
		// item is unmerged until its state is landed or dropped.
		rows, err := r.pool.Query(r.ctx, `SELECT number FROM mythical_items WHERE number IS NOT NULL AND state NOT IN ('landed', 'cancelled', 'rejected', 'declined') ORDER BY stack_position`)
		if err != nil {
			return err
		}
		var stored []int64
		for rows.Next() {
			var n int64
			if err = rows.Scan(&n); err != nil {
				rows.Close()
				return err
			}
			stored = append(stored, n)
		}
		rows.Close()
		// The live Home follows the stack within a second of a change.
		var listed []int64
		var problem error
		frame, err := owner.latest("home", 5*time.Second, func(frame liveFrame) bool {
			listed, problem = nil, nil
			place := int64(0)
			for _, item := range decodeHome(frame).Items {
				if item.State == "merged" || item.State == "dropped" {
					continue
				}
				if slices.Contains(listed, item.N) {
					problem = fmt.Errorf("T%d is listed twice", item.N)
				}
				if item.Place <= place {
					problem = fmt.Errorf("T%d has place %d after place %d", item.N, item.Place, place)
				}
				place = item.Place
				listed = append(listed, item.N)
			}
			return problem == nil && slices.Equal(listed, stored)
		})
		if err != nil {
			if problem != nil {
				return problem
			}
			return fmt.Errorf("%w: live Home lists %v, the stack holds %v", err, listed, stored)
		}
		r.actual = fmt.Sprintf("snap cursor %d: %v by place; counts %v", *frame.Cursor, listed, decodeHome(frame).Counts)
		return nil
	})
	// C-J4-01 step 9: Home is a shared topic, so every member's browser
	// receives the same bytes at one cursor; role, filter and last look stay
	// in each browser.
	r.step("5b One Home for three members", "GET /api/live (home) as the owner, maintainer Ben and member Alice", "the three home snapshots at one cursor are byte-identical", "T-APP-01, T-COL-02", func() error {
		if liveErr != nil {
			return liveErr
		}
		sockets := []*liveSocket{owner}
		for _, person := range []struct {
			login      string
			id         int64
			permission string
		}{{"ben", 201, "maintain"}, {"alice", 202, "write"}} {
			jar, err := r.member(person.login, person.id, person.permission)
			if err != nil {
				return err
			}
			socket, err := r.openLive(jar)
			if err != nil {
				return fmt.Errorf("%s: %w", person.login, err)
			}
			if _, err = socket.subscribe("home"); err != nil {
				return err
			}
			sockets = append(sockets, socket)
		}
		// Find a cursor all three received and compare its bytes.
		deadline := time.Now().Add(10 * time.Second)
		for {
			seen := map[int64][]string{}
			for _, socket := range sockets {
				for _, frame := range socket.received("home") {
					if frame.T == "snap" {
						seen[*frame.Cursor] = append(seen[*frame.Cursor], string(frame.Data))
					}
				}
			}
			for cursor, payloads := range seen {
				if len(payloads) != len(sockets) {
					continue
				}
				for _, payload := range payloads[1:] {
					if payload != payloads[0] {
						return fmt.Errorf("home at cursor %d differs between members", cursor)
					}
				}
				r.actual = fmt.Sprintf("cursor %d: 3 identical snapshots of %d bytes", cursor, len(payloads[0]))
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("no home cursor reached all three members within 10 s")
			}
			time.Sleep(200 * time.Millisecond)
		}
	})
	r.step("6 One Merge, on T1", "GET /api/todos", "exactly one in_review item at place 1 with merge ready and no draft PR, and it is T1; every later in_review item waits on order", "T-APP-01, T-STK-04", func() error {
		list, err := r.todoList()
		if err != nil {
			return err
		}
		var ready []int64
		for _, todo := range list {
			if todo.State != "in_review" {
				continue
			}
			if todo.Place == 1 && todo.Merge.State == "ready" && !todo.PR.Draft {
				ready = append(ready, todo.N)
			} else if todo.Merge.State == "ready" || todo.Merge.Reason != "order" {
				return fmt.Errorf("later in_review T%d: merge %s (%s), want waiting on order", todo.N, todo.Merge.State, todo.Merge.Reason)
			}
		}
		if !slices.Equal(ready, []int64{t1}) {
			return fmt.Errorf("mergeable in_review items %v, want [T%d]", ready, t1)
		}
		return nil
	})
	// The 202s rows 7, 9 and 13 answered, which row 15 compares with the
	// facts /api/live served after them.
	var answered, merged j4Receipt
	var retriedAt time.Time
	var retriedTo int
	var chats []<-chan error
	if !r.step("7 Answer T2 while chatting", "POST /api/todos/{T2}/answer beside POST "+chat.TurnPath, "202 within 1 s; the same answer again 202; T2 leaves needs_you", "T-STK-01, T-APP-03", func() error {
		chats = append(chats, r.besideChat())
		began := time.Now()
		code, data, err := r.answer(t2, wait2, answer2)
		if err != nil {
			return err
		}
		took := time.Since(began)
		if code != 202 || took > time.Second {
			return fmt.Errorf("answer: HTTP %d after %s: %s", code, took, data)
		}
		answered = j4Receipt{at: time.Now(), body: string(data)}
		if code, data, err = r.answer(t2, wait2, answer2); err != nil || code != 202 {
			return fmt.Errorf("the same answer again: HTTP %d %s %v", code, data, err)
		}
		v, err := r.waitTodoWithin(t2, time.Minute, "working", "in_review")
		if err != nil {
			return err
		}
		r.actual = fmt.Sprintf("202 in %s; T%d %s", took.Round(time.Millisecond), t2, v.State)
		return nil
	}) {
		return
	}
	if !r.step("9 Merge T1 while chatting", "POST /api/todos/{T1}/merge beside POST "+chat.TurnPath, "202 within 1 s; reviewed head; one session-bound checks.Land", "T-STK-04", func() error {
		chats = append(chats, r.besideChat())
		began := time.Now()
		if err := r.merge(t1, head1); err != nil {
			return err
		}
		merged = j4Receipt{at: time.Now(), body: r.actual}
		if took := time.Since(began); took > time.Second {
			return fmt.Errorf("merge took %s", took)
		}
		return nil
	}) {
		return
	}
	if !r.step("8 Chat during answer and merge", "POST "+chat.TurnPath+" ×2", "both turns answer with JOURNEY.md's File card while the answer and the merge run", "T-APP-03", func() error {
		if len(chats) != 2 {
			return fmt.Errorf("%d chats ran beside the actions, want 2", len(chats))
		}
		for i, settled := range chats {
			select {
			case err := <-settled:
				if err != nil {
					return fmt.Errorf("chat %d: %w", i+1, err)
				}
			case <-time.After(time.Minute):
				return fmt.Errorf("chat %d did not settle within a minute", i+1)
			}
		}
		r.actual = "200 two File card answers beside the answer and the merge"
		return nil
	}) {
		return
	}
	if !r.step("10 T1 merged", "GET /api/todos/{T1}; GitHub fake; GET /api/github/sync", "merged only after GitHub's head-bound squash; the install's main follows it", "T-STK-04, T-GH-02", func() error {
		return r.waitMerged(t1, pr1, head1)
	}) {
		return
	}
	// J4.1d: an external GitHub main push must be observed without a webhook
	// or a Retry press. The normal 30 s sweep owns this read.
	r.step("18 main row synced", "GitHub fake main push; GET /api/github/sync; GET /api/live (home)", "200; success after push within one poll; Home carries the receipt and occupied machine slots", "T-GH-02, T-APP-01", func() error {
		if liveErr != nil {
			return liveErr
		}
		return r.syncRow(owner)
	})
	r.step("14a T3 failed", "GET /api/todos/{T3}", "failed: [FAIL] empties JOURNEY.md, so its checks fail on every attempt", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t3, 20*time.Minute, "failed")
		if err != nil {
			return err
		}
		var reason string
		var attempt int
		if err = r.pool.QueryRow(r.ctx, `SELECT reason, attempt FROM mythical_items WHERE number=$1`, t3).Scan(&reason, &attempt); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("200 T%d %s after attempt %d: %s", t3, v.State, attempt, reason)
		return nil
	})
	// T2 started beside T1, so T1's candidate moved the stack under it: T2
	// reaches review once the stack rebases it onto its prefix and checks it.
	r.step("11 T2 in review with the answer", "GET /api/todos/{T2}; GitHub fake PR", "in_review; the question settled; t2.md at the PR head carries the answer", "T-STK-01, T-STK-08", func() error {
		v, err := r.waitTodoWithin(t2, 4*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if len(v.Waits) > 0 {
			return fmt.Errorf("T2 still waits on %s %q", v.Waits[0].Kind, v.Waits[0].Prompt)
		}
		if len(v.PR.Head) != 40 {
			return fmt.Errorf("T2 in review has no PR head")
		}
		content, err := r.githubGit("show", v.PR.Head+":t2.md")
		if err != nil {
			return err
		}
		if !strings.Contains(content, answer2) {
			return fmt.Errorf("t2.md at %s does not carry the answer: %q", v.PR.Head, content)
		}
		r.actual = fmt.Sprintf("200 T%d in_review; t2.md %q", t2, content)
		return nil
	})
	r.step("11b T4 in review", "POST /api/todos; GET /api/todos/{T4}", "filed on the merged main; in_review: the ready item a person moves above the failing T3", "T-STK-01", func() error {
		var err error
		if t4, err = r.file("T4 ready", "[PR] [FILE t4.md] Add a greeting to t4.md"); err != nil {
			return err
		}
		_, err = r.waitTodoWithin(t4, 10*time.Minute, "in_review")
		return err
	})
	// T4, in review, moves above the failed T3: the stack now merges T2, T4,
	// T3, and T4, built on main, holds none of T3's bytes.
	r.step("12 Move T4 above T3", "POST /api/todos/{T4} {op: move, direction: up} ×2", "202 within 1 s naming T4's new place; the same press again answers it; order T2, T4, T3; T4 reads 'Merges after T2'; T4 holds no bytes of T3; one todo.moved fact", "T-STK-02", func() error {
		if t4 <= 0 {
			return fmt.Errorf("blocked by row 11b: T4 was not filed")
		}
		path, body, key := fmt.Sprintf("/api/todos/%d", t4), `{"op":"move","direction":"up"}`, r.keyPrefix+"move-t4"
		var receipt struct {
			State string `json:"state"`
			Place int64  `json:"place"`
		}
		began := time.Now()
		code, data, err := r.keyed("POST", path, body, key)
		took := time.Since(began)
		if err != nil {
			return err
		}
		if code != 202 || took > time.Second || json.Unmarshal(data, &receipt) != nil || receipt.State != "accepted" || receipt.Place <= 0 {
			return fmt.Errorf("move: HTTP %d after %s: %s", code, took, data)
		}
		// A double press sends the same request again: it is that move.
		if code, again, err := r.keyed("POST", path, body, key); err != nil || code != 202 || string(again) != string(data) {
			return fmt.Errorf("the same press again: HTTP %d %s %v (first %s)", code, again, err, data)
		}
		rows, err := r.pool.Query(r.ctx, `SELECT number FROM mythical_items WHERE number IS NOT NULL AND state NOT IN ('landed', 'cancelled', 'rejected', 'declined') ORDER BY stack_position`)
		if err != nil {
			return err
		}
		var order []int64
		for rows.Next() {
			var n int64
			if err = rows.Scan(&n); err != nil {
				rows.Close()
				return err
			}
			order = append(order, n)
		}
		rows.Close()
		if !slices.Equal(order, []int64{t2, t4, t3}) {
			return fmt.Errorf("the stack's order is %v, want T%d, T%d, T%d", order, t2, t4, t3)
		}
		var card struct {
			State string `json:"state"`
			Place int64  `json:"place"`
			PR    struct {
				Number int64  `json:"number"`
				Head   string `json:"head"`
			} `json:"pr"`
			Merge struct {
				State  string `json:"state"`
				Reason string `json:"reason"`
				Detail string `json:"detail"`
			} `json:"merge"`
		}
		if data, err = r.expect("GET", path, "", 200); err != nil {
			return err
		}
		if err = json.Unmarshal(data, &card); err != nil {
			return err
		}
		if card.Place != receipt.Place || card.State != "in_review" || card.Merge.Reason != "order" || card.Merge.Detail != fmt.Sprintf("T%d", t2) {
			return fmt.Errorf("T%d reads %s at place %d, merge %s (%s %q); want in_review at place %d, 'Merges after T%d'", t4, card.State, card.Place, card.Merge.State, card.Merge.Reason, card.Merge.Detail, receipt.Place, t2)
		}
		pull, err := r.readFakePull(card.PR.Number)
		if err != nil {
			return err
		}
		files, err := r.prFiles(pull)
		if err != nil {
			return err
		}
		if slices.Contains(files, "t3.md") || !slices.Contains(files, "t4.md") {
			return fmt.Errorf("T%d's PR changes %v, want t4.md and nothing of T%d", t4, files, t3)
		}
		var moves int
		if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type = 'todo.moved' AND (data->>'n')::bigint = $1`, t4).Scan(&moves); err != nil {
			return err
		}
		if moves != 1 {
			return fmt.Errorf("T%d recorded %d todo.moved facts, want 1", t4, moves)
		}
		r.actual = fmt.Sprintf("202 in %s: place %d; again 202; order T%d, T%d, T%d; T%d in_review 'Merges after T%d'; PR #%d changes %v; 1 todo.moved", took.Round(time.Millisecond), receipt.Place, t2, t4, t3, t4, t2, card.PR.Number, files)
		return nil
	})
	// T3 failed on attempt n; Retry with a [FIXED] steer starts attempt n+1,
	// whose first input is the steer, so its checks pass.
	const steer3 = "[FIXED] Keep JOURNEY.md as it is and add the greeting to t3.md"
	var failed3 j4Card
	var traced3 int
	var attempts3 []j4Evidence
	retried := false
	r.step("13 Retry T3 with a steer", "POST /api/todos/{T3} {op: retry, steer: '[FIXED] …'} ×3", "202 within 1 s naming attempt n+1; the same press again answers it; attempt n+1 reaches working; a new press is 409", "T-STK-05", func() error {
		var err error
		if failed3, err = r.j4Card(t3); err != nil {
			return err
		}
		if failed3.State != "failed" || failed3.Run == nil || failed3.Failure == nil || !failed3.Failure.Retryable {
			return fmt.Errorf("T%d is not a retryable failure: state %s, failure %+v", t3, failed3.State, failed3.Failure)
		}
		if attempts3, err = r.attemptsOf(t3); err != nil {
			return err
		}
		turns, err := r.modelTurns()
		if err != nil {
			return err
		}
		traced3 = len(turns)
		path, body, key := fmt.Sprintf("/api/todos/%d", t3), `{"op":"retry","steer":"`+steer3+`"}`, r.keyPrefix+"retry-t3"
		want := failed3.Run.Attempt + 1
		var receipt struct {
			State   string `json:"state"`
			Attempt int32  `json:"attempt"`
		}
		began := time.Now()
		code, data, err := r.keyed("POST", path, body, key)
		took := time.Since(began)
		if err != nil {
			return err
		}
		if code != 202 || took > time.Second || json.Unmarshal(data, &receipt) != nil || receipt.State != "accepted" || receipt.Attempt != want {
			return fmt.Errorf("retry: HTTP %d after %s: %s (want attempt %d)", code, took, data, want)
		}
		retriedAt, retriedTo = time.Now(), int(want)
		// A double press sends the same request again: it is that retry.
		if code, data, err = r.keyed("POST", path, body, key); err != nil || code != 202 || !strings.Contains(string(data), fmt.Sprintf(`"attempt":%d`, want)) {
			return fmt.Errorf("the same press again: HTTP %d %s %v", code, data, err)
		}
		v, err := r.waitTodoWithin(t3, 5*time.Minute, "working", "in_review")
		if err != nil {
			return err
		}
		if v.Run == nil || int32(v.Run.Attempt) != want {
			return fmt.Errorf("T%d is %s on run %+v, want attempt %d", t3, v.State, v.Run, want)
		}
		// A new press once T3 left failed starts nothing.
		if code, data, err = r.keyed("POST", path, body, key+"-again"); err != nil || code != 409 {
			return fmt.Errorf("a new press after the retry: HTTP %d %s %v", code, data, err)
		}
		r.actual = fmt.Sprintf("202 in %s: attempt %d (was %d, %s: %s); again 202; T%d %s on attempt %d; new press 409", took.Round(time.Millisecond), want, failed3.Run.Attempt, failed3.Failure.Step, failed3.Failure.Message, t3, v.State, v.Run.Attempt)
		retried = true
		return nil
	})
	r.step("14b The steer reaches attempt n+1", "GET /api/todos/{T3}; model trace; SQL mythical_items", "steers[0] is the owner's steer; attempts 1..n keep their evidence; attempt n+1's first model turn carries the steer; one retry; T3 in_review on attempt n+1", "T-STK-05", func() error {
		if !retried {
			return fmt.Errorf("blocked by row 13: T%d was not retried", t3)
		}
		if _, err := r.waitTodoWithin(t3, 8*time.Minute, "in_review"); err != nil {
			return err
		}
		card, err := r.j4Card(t3)
		if err != nil {
			return err
		}
		want := failed3.Run.Attempt + 1
		if card.Run == nil || card.Run.Attempt != want {
			return fmt.Errorf("T%d in review on run %+v, want attempt %d", t3, card.Run, want)
		}
		if len(card.Steers) != 1 || card.Steers[0].Text != steer3 || card.Steers[0].By.Kind != "person" || card.Steers[0].By.Login == "" {
			return fmt.Errorf("steers %+v, want one by the owner: %q", card.Steers, steer3)
		}
		// Every earlier attempt keeps its recorded evidence: on the card, and
		// as the stack stored it (checks.attempts), where attempt 1's row is.
		for _, before := range failed3.Evidence {
			if len(recordedEvidence(before.Items)) == 0 {
				continue // the card lists an attempt only with recorded items
			}
			i := slices.IndexFunc(card.Evidence, func(after j4Evidence) bool { return after.Attempt == before.Attempt })
			if before.Attempt < want && (i < 0 || !reflect.DeepEqual(recordedEvidence(card.Evidence[i].Items), recordedEvidence(before.Items))) {
				return fmt.Errorf("attempt %d's evidence changed after the retry: %+v", before.Attempt, card.Evidence)
			}
		}
		stored, err := r.attemptsOf(t3)
		if err != nil {
			return err
		}
		if len(attempts3) == 0 || attempts3[0].Attempt != 1 {
			return fmt.Errorf("T%d stored no attempt 1 evidence before the retry: %+v", t3, attempts3)
		}
		for _, before := range attempts3 {
			i := slices.IndexFunc(stored, func(after j4Evidence) bool { return after.Attempt == before.Attempt })
			if i < 0 || !reflect.DeepEqual(stored[i], before) {
				return fmt.Errorf("stored attempt %d changed after the retry: %+v, was %+v", before.Attempt, stored, attempts3)
			}
		}
		kept := len(attempts3)
		turns, err := r.modelTurns()
		if err != nil {
			return err
		}
		first := -1
		for i := traced3; i < len(turns) && first < 0; i++ {
			if strings.Contains(turnText(turns[i]), "t3.md") {
				first = i
			}
		}
		if first < 0 {
			return fmt.Errorf("no model turn of T%d after the retry (%d turns traced)", t3, len(turns))
		}
		if !strings.Contains(turnText(turns[first]), steer3) {
			return fmt.Errorf("attempt %d's first model turn (%v) does not carry the steer", want, turns[first]["step"])
		}
		var retries int
		if err = r.pool.QueryRow(r.ctx, `SELECT coalesce(jsonb_array_length(checks->'retries'), 0) FROM mythical_items WHERE number=$1`, t3).Scan(&retries); err != nil {
			return err
		}
		if retries != 1 {
			return fmt.Errorf("T%d recorded %d retries, want 1", t3, retries)
		}
		r.actual = fmt.Sprintf("200 T%d in_review on attempt %d; steers[0] by %s; %d earlier attempts' evidence kept; turn %d (%v) carries the steer; 1 retry", t3, want, card.Steers[0].By.Login, kept, first+1, turns[first]["step"])
		return nil
	})
	r.step("15 Receipts settle late", "GET /api/live (home, todo:<n>) after the 202s of rows 7, 9 and 13", "each toast settles from the served fact, not the 202", "T-APP-01, T-COL-02", func() error {
		if liveErr != nil {
			return liveErr
		}
		var settled []string
		// A 202 is admission: it names no outcome a toast could settle on.
		for _, accepted := range []j4Receipt{answered, merged} {
			if accepted.at.IsZero() {
				return fmt.Errorf("an earlier row sent no 202 to compare")
			}
			if strings.Contains(accepted.body, `"outcome"`) {
				return fmt.Errorf("a 202 carries its outcome: %s", accepted.body)
			}
		}
		check := func(name, topic string, after time.Time, fact func(liveFrame) bool) error {
			frame, err := owner.wait(topic, 2*time.Minute, func(frame liveFrame) bool { return frame.At.After(after) && fact(frame) })
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			settled = append(settled, fmt.Sprintf("%s on %s %s after its 202", name, topic, frame.At.Sub(after).Round(time.Millisecond)))
			return nil
		}
		if err := check("answer", fmt.Sprintf("todo:%d", t2), answered.at, func(frame liveFrame) bool {
			return !slices.ContainsFunc(decodeTodo(frame).Waits, func(wait liveWait) bool { return wait.ID == wait2 })
		}); err != nil {
			return err
		}
		if err := check("merge", fmt.Sprintf("todo:%d", t1), merged.at, func(frame liveFrame) bool { return decodeTodo(frame).State == "merged" }); err != nil {
			return err
		}
		if err := check("home", "home", merged.at, func(frame liveFrame) bool {
			return !slices.ContainsFunc(decodeHome(frame).Items, func(item liveHomeItem) bool { return item.N == t1 })
		}); err != nil {
			return err
		}
		if !retriedAt.IsZero() {
			if err := check("retry", fmt.Sprintf("todo:%d", t3), retriedAt, func(frame liveFrame) bool {
				todo := decodeTodo(frame)
				return todo.Run != nil && todo.Run.Attempt == retriedTo && todo.State != "queued" && todo.State != "starting"
			}); err != nil {
				return err
			}
		}
		r.actual = strings.Join(settled, "; ")
		return nil
	})
	r.pending("16 Merged since last look", "PUT view state; GET /api/todos", "the browser derives [T1] after the merge and [] after a new look", "T-APP-01", "last-look")
	r.pending("17 T2 ready after T1 merges", "GitHub fake PR; GET /api/todos", "T2 rebases onto the merged main; one ready-for-review change on T2's PR; merge.state ready on T2 only", "T-STK-04, T-STK-08", "second-merge")

	r.pending("19 Retry and dismiss failed background runs", "POST /api/runs/{id}", "Retry starts exactly one run; Dismiss removes the row for everyone; 403 without the role", "T-APP-01", "background-runs")
	r.pending("20 Ben merges, Alice answers", "POST /api/todos/{n}/merge and /answer as Ben and Alice", "maintainer Ben merges; member Alice answers and her merge is 403", "T-ACC-02", "members")
}

// j4Receipt is a 202 a row received: when, and its body.
type j4Receipt struct {
	at   time.Time
	body string
}

// TestJ4SyncRowRehearsal runs J4.1d independently of the TODO model's long
// failure/retry walk, using the same install and the same HTTP/live row.
func TestJ4SyncRowRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J4_REHEARSAL", "C-J4-sync", "j4-sync-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	socket, err := r.openLive(r.jar)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = socket.subscribe("home"); err != nil {
		t.Fatal(err)
	}
	r.step("18 main row synced", "GitHub fake main push; GET /api/github/sync; GET /api/live (home)", "200 fresh after external push within one poll; Home receipt and occupied slots agree", "T-GH-02, T-APP-01", func() error { return r.syncRow(socket) })
}

func (r *rehearsal) syncRow(owner *liveSocket) error {
	base, err := r.githubGit("rev-parse", "refs/heads/main")
	if err != nil {
		return err
	}
	tree, err := r.githubGit("rev-parse", base+"^{tree}")
	if err != nil {
		return err
	}
	tip, err := r.githubGit("-c", "user.name=Rehearsal", "-c", "user.email=owner@example.test", "commit-tree", tree, "-p", base, "-m", "External main push")
	if err != nil {
		return err
	}
	pushed := time.Now()
	if _, err = r.githubGit("update-ref", "refs/heads/main", tip, base); err != nil {
		return err
	}
	// Five seconds of scheduling allowance bounds a 30 s poll on a busy mini.
	deadline := pushed.Add(35 * time.Second)
	var health struct {
		State         string     `json:"state"`
		LastSuccessAt *time.Time `json:"last_success_at"`
	}
	for {
		data, err := r.expect("GET", "/api/github/sync", "", 200)
		if err != nil {
			return err
		}
		if err = json.Unmarshal(data, &health); err != nil {
			return err
		}
		var mirrored string
		if err = r.pool.QueryRow(r.ctx, `SELECT smithers_head FROM github_main_pulls WHERE github_head=$1 AND state='synced'`, tip).Scan(&mirrored); err == nil && mirrored == tip && health.LastSuccessAt != nil && !health.LastSuccessAt.Before(pushed) && health.State == "fresh" {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("external main %s not synced in one poll: %+v", tip, health)
		}
		select {
		case <-r.ctx.Done():
			return r.ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	frame, err := owner.latest("home", 5*time.Second, func(frame liveFrame) bool {
		var home struct {
			Main struct {
				LastSuccessAt time.Time `json:"last_success_at"`
				Health        string    `json:"health"`
			}
			Machines struct {
				InUse int `json:"in_use"`
				Slots []json.RawMessage
			}
		}
		return json.Unmarshal(frame.Data, &home) == nil && home.Main.LastSuccessAt.Equal(*health.LastSuccessAt) && home.Main.Health == "fresh" && home.Machines.InUse == len(home.Machines.Slots)
	})
	if err != nil {
		return err
	}
	r.actual = fmt.Sprintf("200 fresh, success %s after push in %s; Home cursor %d with occupied slots", health.LastSuccessAt.Format(time.RFC3339Nano), health.LastSuccessAt.Sub(pushed).Round(time.Millisecond), *frame.Cursor)
	return nil
}
