package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
)

// TestJ7Rehearsal walks journey J7 (mvp.md §5, plan and fork; C-J7-01..03)
// on the install J1 sets up. Its setup is C-J7-01's stack at the default
// parallel of 2: T1 in review, T2 working and held at its edit, T3 behind
// it and held too ([HOLD key] markers of distribution/fake-todo-turns.mjs).
// TN goes before T3 and is held at its edit too (row 6). The owner amends T2
// while its edit is held, and its run plans and implements the amendment
// (rows 7 and 8). TN and T1 rebase onto their moved prefix (rows 9 and 16),
// and T2 is dropped (row 15). The add-to-stack and conflict rows wait on
// their lanes and are listed as pending.
func TestJ7Rehearsal(t *testing.T) {
	// The model trace keeps each turn's messages: row 8 reads the amendment
	// in T2's turns after it.
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, "SMITHERS_J7_REHEARSAL", "C-J7", "j7-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	// Held turns are answered before the install stops.
	defer func() {
		_ = r.release("t2")
		_ = r.release("tn")
		_ = r.release("t3")
	}()
	if !r.step("1 Parallel defaults to 2", "SQL mythical_stacks.max_parallel", "2, with no PUT /api/install", "T-STK-03", func() error {
		var parallel int
		if err := r.pool.QueryRow(r.ctx, `SELECT max_parallel FROM mythical_stacks`).Scan(&parallel); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("max_parallel=%d", parallel)
		if parallel != 2 {
			return fmt.Errorf("the stack's parallel is %d, want 2", parallel)
		}
		return nil
	}) {
		return
	}
	var t1, t2, t3 int64
	if !r.step("2 File T1, T2, T3", "POST /api/todos ×3; GET /api/todos", "202 ×3; place order T1, T2, T3", "T-STK-01", func() error {
		var err error
		if t1, err = r.file("T1 ready", "[PR] [FILE t1.md] Add a greeting to t1.md"); err != nil {
			return err
		}
		if t2, err = r.file("T2 retries", "[HOLD t2] [FILE t2.md] Add a retry helper note to t2.md"); err != nil {
			return err
		}
		if t3, err = r.file("T3 jitter", "[HOLD t3] [FILE t3.md] Add a jitter note to t3.md"); err != nil {
			return err
		}
		list, err := r.todoList()
		if err != nil {
			return err
		}
		var placed []int64
		for _, todo := range list {
			placed = append(placed, todo.N)
		}
		if !slices.Equal(placed, []int64{t1, t2, t3}) {
			return fmt.Errorf("GET /api/todos lists %v, want %v", placed, []int64{t1, t2, t3})
		}
		return nil
	}) {
		return
	}
	if !r.step("3 T1 in review", "GET /api/todos/{T1}; GitHub fake PR", "in_review; PR smithers/<slug> at the card's head, base main", "T-STK-01", func() error {
		v, err := r.waitTodoWithin(t1, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		_, err = r.checkPull(v.PR.Number, v.PR.Head)
		return err
	}) {
		return
	}
	if !r.step("4 T2 held in Working", "GET /api/todos/{T2}; scripted model /held", "working with its own branch; its edit turn held on [HOLD t2]", "T-STK-01", func() error {
		if err := r.waitHeld("t2", 8*time.Minute); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(t2, time.Minute, "working")
		if err != nil {
			return err
		}
		if v.Branch == nil || v.Branch.ID == "" {
			return fmt.Errorf("working T%d has no branch", t2)
		}
		r.actual = fmt.Sprintf("200 T%d working on branch %s; edit held", t2, v.Branch.ID)
		return nil
	}) {
		return
	}
	r.step("5 T3 after T2", "GET /api/todos/{T3}", "T3 is placed after T2 and not in review", "T-STK-01", func() error {
		v, err := r.todo(t3)
		if err != nil {
			return err
		}
		v2, err := r.todo(t2)
		if err != nil {
			return err
		}
		if v.Place <= v2.Place || v.State == "in_review" || v.State == "merged" {
			return fmt.Errorf("T%d at place %d is %s; T%d at place %d", t3, v.Place, v.State, t2, v2.Place)
		}
		r.actual = fmt.Sprintf("200 T%d %s at place %d", t3, v.State, v.Place)
		return nil
	})
	var tn int64
	r.step("6 Insert TN before T3", "POST /api/todos {place: before T3}; GET /api/todos; SQL product_job_events", "order T1, T2, TN, T3; T3 is not admitted before TN; one product_job_events row", "T-STK-02", func() error {
		body, _ := json.Marshal(map[string]any{"title": "TN jitter helper", "prompt": "[HOLD tn] [FILE tn.md] Add a jitter helper note to tn.md",
			"place": map[string]any{"mode": "before", "n": t3}})
		code, data, err := r.keyed("POST", "/api/todos", string(body), r.keyPrefix+"todo-tn")
		if err != nil {
			return err
		}
		var receipt struct {
			State string `json:"state"`
			N     int64  `json:"n"`
		}
		if code != 202 || json.Unmarshal(data, &receipt) != nil || receipt.State != "accepted" || receipt.N <= 0 {
			return fmt.Errorf("Before T%d: HTTP %d %s", t3, code, data)
		}
		tn = receipt.N
		list, err := r.todoList()
		if err != nil {
			return err
		}
		var placed []int64
		for _, todo := range list {
			if todo.State != "merged" && todo.State != "dropped" {
				placed = append(placed, todo.N)
			}
		}
		if !slices.Equal(placed, []int64{t1, t2, tn, t3}) {
			return fmt.Errorf("GET /api/todos lists %v, want T%d, T%d, T%d, T%d", placed, t1, t2, tn, t3)
		}
		var facts int
		if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type = 'todo.created' AND (data->>'n')::bigint = $1 AND (data->>'before')::bigint = $2`, tn, t3).Scan(&facts); err != nil {
			return err
		}
		if facts != 1 {
			return fmt.Errorf("T%d has %d todo.created facts naming Before T%d, want 1", tn, facts, t3)
		}
		// The next free slot goes to TN: T3 stays queued until TN starts.
		for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(500 * time.Millisecond) {
			n, err := r.todo(tn)
			if err != nil {
				return err
			}
			three, err := r.todo(t3)
			if err != nil {
				return err
			}
			if three.State != "queued" {
				return fmt.Errorf("T%d is %s while T%d is %s: T%d was admitted first", t3, three.State, tn, n.State, t3)
			}
			if n.State != "queued" {
				r.actual = fmt.Sprintf("202 T%d; order T%d, T%d, T%d, T%d; T%d %s while T%d queued; 1 todo.created naming Before T%d", tn, t1, t2, tn, t3, tn, n.State, t3, t3)
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("neither T%d nor T%d was admitted within 5m", tn, t3)
			}
		}
	})
	amend := r.amendT2(t2)
	r.step("7 Amend T2", "PATCH /api/todos/{T2} {prompt, acceptance} ×2; GET /api/todos; SQL product_job_requests",
		"202 {n: T2, rev: 2} within 1 s; the same press again 202 rev 2; revision 2 with reason amend by the owner (+1); same run, no new TODO; the amendment sent to T2's live run",
		"T-STK-06", amend.press)
	r.step("8 The amendment reaches T2's run", "release [HOLD t2]; model trace; GET /api/todos/{T2}; GitHub fake PR",
		"T2's same run plans again with the amendment and its next implement turn carries it; T2's PR has t2.md and the amendment's CHANGELOG.md", "T-STK-06", amend.reached)
	// The TODO after T2 is TN (row 6), else T3: it started on T1's verified
	// head beside T2, so T2's verified head moves its prefix and it rebases
	// onto it.
	r.step("9 TN builds on T2's verified head", "release [HOLD t2], [HOLD tn]; GET /api/todos/{T2,TN}; SQL mythical_items; GitHub fake PR",
		"TN's base is T2's verified head after one verify run; its PR waits on T1 and includes T1 and T2", "T-STK-12, T-STK-08", func() error {
			if err := r.release("t2"); err != nil {
				return err
			}
			if _, err := r.waitTodoWithin(t2, 8*time.Minute, "in_review"); err != nil {
				return fmt.Errorf("T%d: %w", t2, err)
			}
			next, key, file := t3, "t3", "t3.md"
			if tn > 0 {
				next, key, file = tn, "tn", "tn.md"
			}
			if err := r.waitHeld(key, 8*time.Minute); err != nil {
				return err
			}
			if err := r.release(key); err != nil {
				return err
			}
			if _, err := r.waitTodoWithin(next, 8*time.Minute, "in_review"); err != nil {
				return fmt.Errorf("T%d: %w", next, err)
			}
			c2, err := r.candidate(t2)
			if err != nil {
				return err
			}
			cn, err := r.candidate(next)
			if err != nil {
				return err
			}
			if !c2.Verified || cn.Base != c2.Head {
				return fmt.Errorf("T%d's base %s is not T%d's verified head %s (verified=%t)", next, short7(cn.Base), t2, short7(c2.Head), c2.Verified)
			}
			if cn.Verifies != 1 {
				return fmt.Errorf("T%d ran %d verify runs, want 1", next, cn.Verifies)
			}
			card, err := r.j7Card(next)
			if err != nil {
				return err
			}
			if !slices.Contains(card.PR.IncludedItems, t1) || !slices.Contains(card.PR.IncludedItems, t2) {
				return fmt.Errorf("T%d's PR includes %v, want T%d and T%d", next, card.PR.IncludedItems, t1, t2)
			}
			pull, err := r.readFakePull(card.PR.Number)
			if err != nil {
				return err
			}
			// A private repository has no drafts: the later PR opens ready,
			// titled with the TODO it waits for (§12.5.1).
			if pull.Head.SHA != card.PR.Head || !pull.Draft && !strings.HasPrefix(pull.Title, fmt.Sprintf("[waits for T%d]", t1)) {
				return fmt.Errorf("T%d's PR #%d head %s draft=%t title %q", next, pull.Number, short7(pull.Head.SHA), pull.Draft, pull.Title)
			}
			for _, file := range []string{"t1.md", "t2.md", file} {
				if _, err := r.githubGit("cat-file", "-e", card.PR.Head+":"+file); err != nil {
					return fmt.Errorf("T%d's PR head lacks %s: %w", next, file, err)
				}
			}
			r.actual = fmt.Sprintf("200 T%d base %s = T%d's verified head; 1 verify run; PR #%d %q includes %v with t1.md, t2.md, %s",
				next, short7(cn.Base), t2, pull.Number, pull.Title, card.PR.IncludedItems, file)
			return nil
		})
	var scratch j7Scratch
	r.step("10 Fork T2", "POST /api/branches {from: T2}; GET /api/branches/{b}; SQL mythical_items, workspaces", "201; forked_from {T2, H2, C1}; T2's run and workspace unchanged", "T-MCH-08", func() error {
		return r.forkT2(t1, t2, &scratch)
	})
	r.step("11 Scratch stays off GitHub", "Git door ls-remote; GitHub fake refs", "no smithers/ branch or PR for the scratch branch", "T-MCH-08", func() error {
		return r.scratchOffGitHub(&scratch)
	})
	r.step("12 Edit on scratch", "Git push to the scratch branch; GET /api/branches/{b}", "the head moves to S, a descendant of H2", "T-MCH-08", func() error {
		return r.editScratch(&scratch)
	})
	r.pending("13 Add to stack after T2", "POST /api/todos from the scratch branch", "a new TODO after T2 holding the scratch branch's change", "T-MCH-08", "add-to-stack")
	r.pending("14 The new TODO keeps T2's work", "GitHub fake PR diff", "dropping T2 leaves its tree unchanged; the PR has T2's file and the scratch edit", "T-MCH-08", "add-to-stack")
	r.step("15 Drop T2", "POST /api/todos/{T2} {op: drop}", "dropped; the PR closed with the comment; the run cancelled", "T-STK-02, T-STK-05", func() error {
		return r.drop(t2)
	})
	r.step("16 main moves cleanly", "Merge T1 refused on GitHub; GitHub fake main push; POST /api/github/sync; GET /api/todos/{T1}; SQL",
		"T1 rebuilds on the new main with one verify run; the PR head is updated; checks.Land cleared (approval_cleared); T1 stays in review", "T-STK-08", func() error {
			v1, err := r.todo(t1)
			if err != nil {
				return err
			}
			head1 := v1.PR.Head
			c1, err := r.candidate(t1)
			if err != nil {
				return err
			}
			before := c1.Verifies
			// An approval of T1's head that GitHub refuses stays as its receipt.
			r.fake.RefuseNextMerge("rehearsal-owner/app", v1.PR.Number, githubfake.Refusal{Status: 405, Message: "Required status check \"ci\" is expected."})
			if err := r.merge(t1, head1); err != nil {
				return err
			}
			if err := r.waitSQL(time.Minute, `SELECT count(*) FROM mythical_items WHERE number=$1 AND checks->'land'->'refused' IS NOT NULL AND pending_op IS NULL`, t1); err != nil {
				return fmt.Errorf("the refused merge did not settle: %w", err)
			}
			main, err := r.pushMain("OUTSIDE.md", "outside\n", "Outside change on main")
			if err != nil {
				return err
			}
			if _, err := r.expect("POST", "/api/github/sync", "", 202); err != nil {
				return err
			}
			var card j7Card
			for deadline := time.Now().Add(8 * time.Minute); ; time.Sleep(time.Second) {
				if card, err = r.j7Card(t1); err != nil {
					return err
				}
				if c1, err = r.candidate(t1); err != nil {
					return err
				}
				if card.State == "in_review" && card.PR.Head != head1 && c1.Base == main && c1.Verified {
					break
				}
				if card.State != "in_review" || time.Now().After(deadline) {
					err := fmt.Errorf("T%d %s (base %s, verified=%t, PR head %s; main %s; item %s %q)", t1, card.State, short7(c1.Base), c1.Verified, short7(card.PR.Head), short7(main), c1.State, c1.Reason)
					if c1.Base == main && strings.Contains(c1.Reason, "stale_revision") {
						// The rebase itself is done; its checks cannot run off the
						// lane that planned them (follow-up: portable check identity).
						err = fmt.Errorf("%w; coding/verify refuses the plan's checks on any lane but the planning one: a built-in check's execution digest includes its host's state directory (managed-hosts/<binding>), and T1's planning lane was released at review", err)
					}
					return err
				}
			}
			if runs := c1.Verifies - before; runs != 1 {
				return fmt.Errorf("T%d ran %d verify runs for the move, want 1", t1, runs)
			}
			if c1.Land || !card.ApprovalCleared {
				return fmt.Errorf("T%d checks.Land kept=%t, approval_cleared=%t", t1, c1.Land, card.ApprovalCleared)
			}
			pull, err := r.readFakePull(card.PR.Number)
			if err != nil {
				return err
			}
			parent, err := r.githubGit("rev-parse", pull.Head.SHA+"^")
			if err != nil {
				return err
			}
			if pull.Head.SHA != card.PR.Head || parent != main {
				return fmt.Errorf("T%d's PR head %s (parent %s), card head %s, main %s", t1, short7(pull.Head.SHA), short7(parent), short7(card.PR.Head), short7(main))
			}
			r.actual = fmt.Sprintf("200 T%d in_review; PR #%d head %s -> %s on main %s; 1 verify run; checks.Land cleared; approval_cleared",
				t1, pull.Number, short7(head1), short7(pull.Head.SHA), short7(main))
			return nil
		})
	r.pending("17 Conflict, agent resolves once", "conflicting main push; [RESOLVE]", "the agent resolves the conflict once and shows what it did", "T-STK-08", "conflict-once")
	r.pending("18 Conflict, agent fails", "conflicting main push; [NORESOLVE]", "needs_you with Resolve; no further attempts", "T-STK-08", "conflict-once")
	r.pending("19 Done while conflicted", "POST /api/todos/{n} {op: done}", "409", "T-STK-08", "conflict-once")
	r.pending("20 Done after resolve", "POST /api/todos/{n} {op: done}", "202; a check run admitted", "T-STK-08", "conflict-once")
}

// j7Amend is rows 7 and 8: the owner amends T2 while its edit turn is held.
// The amendment asks for a changelog line ([CHANGELOG], which the scripted
// planner carries into its edit atom and the edit turn writes), so T2's
// next implement turn quotes it and its pull request carries its effect.
type j7Amend struct {
	r       *rehearsal
	t2      int64
	key     string
	run     string
	traced  int
	pressed bool
}

const j7Amendment = "[CHANGELOG] Also note the retry helper in CHANGELOG.md."

func (r *rehearsal) amendT2(t2 int64) *j7Amend {
	return &j7Amend{r: r, t2: t2, key: r.keyPrefix + "amend-t2"}
}

// j7Revisions is a TODO card's prompt revisions, run and steers.
type j7Revisions struct {
	State           string `json:"state"`
	PromptRevisions []struct {
		N      int    `json:"n"`
		Reason string `json:"reason"`
		Text   string `json:"text"`
		By     struct {
			Kind  string `json:"kind"`
			Login string `json:"login"`
		} `json:"by"`
	} `json:"prompt_revisions"`
	Steers []any `json:"steers"`
	Run    *struct {
		ID      string `json:"id"`
		Attempt int    `json:"attempt"`
	} `json:"run"`
}

func (r *rehearsal) j7Revisions(number int64) (j7Revisions, error) {
	var card j7Revisions
	data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	if err == nil {
		err = json.Unmarshal(data, &card)
	}
	return card, err
}

func (a *j7Amend) press() error {
	r := a.r
	before, err := r.j7Revisions(a.t2)
	if err != nil {
		return err
	}
	if before.State != "working" || before.Run == nil || before.Run.ID == "" {
		return fmt.Errorf("T%d is %s with run %+v, want working on a run", a.t2, before.State, before.Run)
	}
	a.run = before.Run.ID
	list, err := r.todoList()
	if err != nil {
		return err
	}
	path, body := fmt.Sprintf("/api/todos/%d", a.t2), `{"prompt":"`+j7Amendment+`","acceptance":["CHANGELOG.md mentions the retry helper"]}`
	want := fmt.Sprintf(`{"state":"accepted","n":%d,"rev":2}`, a.t2)
	began := time.Now()
	code, data, err := r.keyed("PATCH", path, body, a.key)
	took := time.Since(began)
	if err != nil {
		return err
	}
	if code != 202 || strings.TrimSpace(string(data)) != want {
		return fmt.Errorf("Amend T%d: %s, want 202 %s", a.t2, r.actual, want)
	}
	if took > time.Second {
		return fmt.Errorf("Amend answered in %s, want within 1 s", took)
	}
	if code, data, err = r.keyed("PATCH", path, body, a.key); err != nil || code != 202 || strings.TrimSpace(string(data)) != want {
		return fmt.Errorf("the same press again: %s", r.actual)
	}
	card, err := r.j7Revisions(a.t2)
	if err != nil {
		return err
	}
	if len(card.PromptRevisions) != 2 {
		return fmt.Errorf("T%d has %d prompt revisions, want 2", a.t2, len(card.PromptRevisions))
	}
	revision := card.PromptRevisions[1]
	if revision.N != 2 || revision.Reason != "amend" || revision.Text != j7Amendment || revision.By.Kind != "person" || revision.By.Login == "" {
		return fmt.Errorf("revision 2 is %+v", revision)
	}
	if len(card.Steers) != 0 {
		return fmt.Errorf("the amendment shows as a steer too: %v", card.Steers)
	}
	if card.Run == nil || card.Run.ID != a.run || card.Run.Attempt != before.Run.Attempt {
		return fmt.Errorf("T%d's run moved from %s to %+v", a.t2, a.run, card.Run)
	}
	after, err := r.todoList()
	if err != nil {
		return err
	}
	if len(after) != len(list) {
		return fmt.Errorf("GET /api/todos lists %d TODOs after Amend, %d before", len(after), len(list))
	}
	if err = r.waitRequest("todo-steer:%:amend:"+a.key, "completed", time.Minute); err != nil {
		return err
	}
	turns, err := r.modelTurns()
	if err != nil {
		return err
	}
	a.traced, a.pressed = len(turns), true
	r.actual = fmt.Sprintf("202 %s in %dms; again 202 rev 2; revision 2 amend by %s; run %s attempt %d unchanged; %d TODOs; delivered to the live run while its edit is held",
		want, took.Milliseconds(), revision.By.Login, a.run, card.Run.Attempt, len(after))
	return nil
}

func (a *j7Amend) reached() error {
	r := a.r
	if !a.pressed {
		return fmt.Errorf("blocked by row 7: no amendment delivered")
	}
	if err := r.release("t2"); err != nil {
		return err
	}
	planned, implemented := "", ""
	for deadline := time.Now().Add(6 * time.Minute); implemented == ""; time.Sleep(time.Second) {
		turns, err := r.modelTurns()
		if err != nil {
			return err
		}
		planned = ""
		for _, turn := range turns[min(a.traced, len(turns)):] {
			text, step := turnText(turn), fmt.Sprint(turn["step"])
			if !strings.Contains(text, "t2.md") {
				continue
			}
			if planned == "" && (step == "coding/review-request" || step == "coding/draft-plan") {
				if !strings.Contains(text, j7Amendment) {
					return fmt.Errorf("T%d's next planning turn (%s) does not carry the amendment", a.t2, step)
				}
				planned = step
			} else if planned != "" && step == "coding/edit-atom" {
				// The edit atom's intent quotes the request's feedback, which
				// now carries the amendment.
				if !strings.Contains(text, j7Amendment) {
					return fmt.Errorf("T%d's implement turn after the amendment does not carry it", a.t2)
				}
				implemented = step
				break
			}
		}
		if implemented == "" && time.Now().After(deadline) {
			return fmt.Errorf("no implement turn of T%d after the amendment in 6 min (planning turn: %q)", a.t2, planned)
		}
	}
	v, err := r.waitTodoWithin(a.t2, 8*time.Minute, "in_review")
	if err != nil {
		return err
	}
	if v.Run == nil || v.Run.ID != a.run || v.Run.Attempt != 1 {
		return fmt.Errorf("T%d in review on run %+v, want the amended run %s on attempt 1", a.t2, v.Run, a.run)
	}
	for _, file := range []string{"t2.md", "CHANGELOG.md"} {
		if _, err := r.githubGit("cat-file", "-e", v.PR.Head+":"+file); err != nil {
			return fmt.Errorf("T%d's PR head %s lacks %s: %w", a.t2, short7(v.PR.Head), file, err)
		}
	}
	r.actual = fmt.Sprintf("the next %s turn and the next %s turn of run %s carry the amendment; T%d in_review on attempt 1, PR #%d head %s has t2.md and CHANGELOG.md",
		planned, implemented, a.run, a.t2, v.PR.Number, short7(v.PR.Head))
	return nil
}

// j7Card is what rows 9 and 16 read of a TODO card beyond rehearsalTodo.
type j7Card struct {
	State string `json:"state"`
	PR    struct {
		Number        int64   `json:"number"`
		Head          string  `json:"head"`
		Draft         bool    `json:"draft"`
		IncludedItems []int64 `json:"included_items"`
	} `json:"pr"`
	RebasePending *struct {
		Onto string `json:"onto"`
	} `json:"rebase_pending"`
	ApprovalCleared bool `json:"approval_cleared"`
}

func (r *rehearsal) j7Card(number int64) (j7Card, error) {
	var card j7Card
	data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	if err == nil {
		err = json.Unmarshal(data, &card)
	}
	return card, err
}

// j7Candidate is the stack's record of a TODO's candidate: its base and
// head, whether it is verified, its coding/verify launches and whether a
// Review & merge approval stands.
type j7Candidate struct {
	State, Reason, Base, Head string
	Verified, Land            bool
	Verifies                  int64
}

func (r *rehearsal) candidate(number int64) (j7Candidate, error) {
	var c j7Candidate
	err := r.pool.QueryRow(r.ctx, `SELECT i.state, i.reason, i.candidate_base, i.candidate_head, i.candidate_verified, i.checks ? 'land',
		(SELECT count(*) FROM product_job_requests q WHERE q.request_id LIKE 'mythical:' || i.id::text || ':%:verify:%')
		FROM mythical_items i WHERE i.number = $1`, number).Scan(&c.State, &c.Reason, &c.Base, &c.Head, &c.Verified, &c.Land, &c.Verifies)
	return c, err
}

// waitSQL waits until query (a count) answers at least one row.
func (r *rehearsal) waitSQL(within time.Duration, query string, args ...any) error {
	for deadline := time.Now().Add(within); ; time.Sleep(500 * time.Millisecond) {
		var n int
		if err := r.pool.QueryRow(r.ctx, query, args...).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("no row after %s", within)
		}
	}
}

// pushMain commits path on GitHub's main, as a person merging an unrelated
// change outside Smithers would, and answers the new main commit.
func (r *rehearsal) pushMain(path, content, message string) (string, error) {
	dir := filepath.Join(r.gitRoot, "rehearsal-owner/app.git")
	run := func(stdin string, args ...string) (string, error) {
		cmd := exec.Command("/usr/bin/git", append([]string{"--git-dir", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_AUTHOR_NAME=Outside", "GIT_AUTHOR_EMAIL=outside@example.com",
			"GIT_COMMITTER_NAME=Outside", "GIT_COMMITTER_EMAIL=outside@example.com")
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git %s: %v: %s", args[0], err, out)
		}
		return strings.TrimSpace(string(out)), nil
	}
	base, err := run("", "rev-parse", "refs/heads/main")
	if err != nil {
		return "", err
	}
	blob, err := run(content, "hash-object", "-w", "--stdin")
	if err != nil {
		return "", err
	}
	listing, err := run("", "ls-tree", base)
	if err != nil {
		return "", err
	}
	tree, err := run(listing+"\n100644 blob "+blob+"\t"+path+"\n", "mktree")
	if err != nil {
		return "", err
	}
	commit, err := run("", "commit-tree", tree, "-p", base, "-m", message)
	if err != nil {
		return "", err
	}
	_, err = run("", "update-ref", "refs/heads/main", commit, base)
	return commit, err
}

func short7(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}
