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
// TN goes before T3; the owner opens a third slot and holds its edit (row 6).
// The owner amends
// T2 while its edit is held, and its run's next implement turn reads the
// amendment (rows 7 and 8). TN and T1 rebase onto their moved prefix (rows 9
// and 16), T2 is forked to a scratch branch that is edited (rows 10-12), and
// T2 is dropped (row 15). The add-to-stack rows wait on their lane.
// Conflict rows use the independent complete-install cases below so a held
// placement run cannot hide conflict resolution or manual continuation.
func TestJ7Rehearsal(t *testing.T) {
	// The model trace keeps each turn's messages: row 8 reads the amendment
	// in T2's next implement turn.
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
	if !r.step("1 Parallel defaults to 2", "GET /api/install", "parallel=2, capacity=3, with no PUT /api/install", "T-STK-03", func() error {
		data, err := r.expect("GET", "/api/install", "", 200)
		if err != nil {
			return err
		}
		var setting struct {
			Parallel int `json:"parallel"`
			Capacity int `json:"capacity"`
		}
		if err := json.Unmarshal(data, &setting); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("parallel=%d capacity=%d", setting.Parallel, setting.Capacity)
		if setting.Parallel != 2 || setting.Capacity != 3 {
			return fmt.Errorf("the install has %s, want parallel=2 capacity=3", r.actual)
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
	r.step("6 Insert TN before T3", "POST /api/todos {place: before T3}; PUT /api/install {parallel: 3}; GET /api/todos; SQL product_job_events", "order T1, T2, TN, T3; T3 is not admitted before TN; one product_job_events row", "T-STK-02", func() error {
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
		// The Linux adapter does not run automatic idle reclamation, and
		// T1 retains its pinned run for review input. The owner opens the
		// third slot only after insertion, so admission order is observable
		// while T2 remains held for the amendment check.
		if _, err := r.expect("PUT", "/api/install", `{"parallel":3}`, 200); err != nil {
			return err
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
	// T2's edit turn is still held: the amendment reaches its live run.
	const amendment = "Also log each retry."
	r.step("7 Amend T2", "PATCH /api/todos/{T2} {prompt} ×2 (/todo.amend); GET /api/todos/{T2}; GET /api/todos; SQL product_job_events",
		"202 {n: T2, rev: 2} for both presses; revision 2 with reason amend by the owner; T2 shows +1; same run, attempt and branch, still working with no PR; no new TODO; one todo.amended", "T-STK-06", func() error {
			return r.amend(t2, amendment)
		})
	r.step("8 The amendment reaches T2's run", "SQL product_job_requests; release [HOLD t2]; model trace (TRACE_MESSAGES=1)",
		"the steer is delivered to T2's run; T2's next implement turn carries the amendment as a steer", "T-STK-06", func() error {
			return r.amendmentReachesRun(t2, "t2", amendment)
		})
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
	// Rows 13 and 14 wait on scratch capture (T-MCH-08 S2, T-COL-03). Add to
	// stack seeds the scratch machine's captured head: awake, it refuses 503
	// "Capture unavailable" until the machine daemon's capture is composed;
	// asleep, it reads the retained head, which row 12's Git-door push does
	// not move. addScratch and keepsT2 (j7_fork_rehearsal_integration_test.go)
	// are these rows' steps once capture is composed; row 14 runs after row 15.
	r.pending("13 Add to stack after T2", "POST /api/branches/{scratch}/add-to-stack (/branch.add-to-stack)", "a new TODO after T2 holding the scratch branch's change", "T-MCH-08", "scratch-capture")
	r.pending("14 The new TODO keeps T2's work", "GitHub fake PR diff", "dropping T2 leaves its tree unchanged; the PR has T2's file and the scratch edit", "T-MCH-08", "scratch-capture")
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
					return fmt.Errorf("T%d %s (base %s, verified=%t, PR head %s; main %s; item %s %q)", t1, card.State, short7(c1.Base), c1.Verified, short7(card.PR.Head), short7(main), c1.State, c1.Reason)
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
	// Each conflict case owns its install, native daemon and fake GitHub. Reuse
	// the complete boundary proofs instead of maintaining another conflict
	// driver here. These are trusted-process rehearsals, not VM qualification.
	resolved, manual := runJ7RebaseConflictRows(t)
	// The manual rows share one retained conflict. Count them only after the
	// whole sequence passes, including publication; any failure fails all three.
	for _, row := range []struct {
		name, expected string
		passed         bool
	}{
		{"17 Conflict, agent resolves once", "one repair in the same pinned attempt; both sides retained; same PR updated", resolved},
		{"18 Conflict, agent fails", "one failed repair; Needs you with paths after restart and ten worker passes", manual},
		{"19 Done while conflicted", "stale and unresolved Done return 409 without settling the wait", manual},
		{"20 Done after resolve", "real file write; Done 202; same run and PR; fresh checks and review", manual},
	} {
		r.step(row.name, "composed conflict install; Rebase now; Branch Done; GitHub fake", row.expected, "T-STK-08", func() error {
			if !row.passed {
				return fmt.Errorf("complete conflict scenario failed; see its subtest receipt")
			}
			r.actual = row.expected
			return nil
		})
	}
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

// amend is row 7: the owner amends TODO n as /todo.amend does (PATCH
// /api/todos/{n}, spec §10.2.2), twice under one Idempotency-Key. The TODO
// gains revision 2 with reason amend, shown as "+1", keeps its number, run,
// attempt and branch, and stays working with no PR; no TODO is added.
func (r *rehearsal) amend(n int64, text string) error {
	before, err := r.j3Lane(n)
	if err != nil {
		return err
	}
	numbers := func() ([]int64, error) {
		list, err := r.todoList()
		var all []int64
		for _, todo := range list {
			all = append(all, todo.N)
		}
		return all, err
	}
	was, err := numbers()
	if err != nil {
		return err
	}
	path := fmt.Sprintf("/api/todos/%d", n)
	body, err := json.Marshal(map[string]string{"prompt": text})
	if err != nil {
		return err
	}
	for press := 1; press <= 2; press++ {
		code, data, err := r.keyed("PATCH", path, string(body), r.keyPrefix+"amend-t2")
		if err != nil {
			return err
		}
		var receipt struct {
			State string `json:"state"`
			N     int64  `json:"n"`
			Rev   int    `json:"rev"`
		}
		if code != 202 || json.Unmarshal(data, &receipt) != nil || receipt.State != "accepted" || receipt.N != n || receipt.Rev != 2 {
			return fmt.Errorf("Amend press %d: HTTP %d %s, want 202 {n: %d, rev: 2}", press, code, data, n)
		}
	}
	data, err := r.expect("GET", path, "", 200)
	if err != nil {
		return err
	}
	var card struct {
		State           string `json:"state"`
		PromptRevisions []struct {
			Text   string `json:"text"`
			Reason string `json:"reason"`
			By     struct {
				Login string `json:"login"`
			} `json:"by"`
		} `json:"prompt_revisions"`
		Steers []struct {
			Text string `json:"text"`
		} `json:"steers"`
		PR *struct {
			Number int64 `json:"number"`
		} `json:"pr"`
	}
	if err := json.Unmarshal(data, &card); err != nil {
		return err
	}
	if len(card.PromptRevisions) != 2 {
		return fmt.Errorf("T%d has %d prompt revisions, want 2: %s", n, len(card.PromptRevisions), data)
	}
	if revision := card.PromptRevisions[1]; revision.Reason != "amend" || revision.Text != text || revision.By.Login != "rehearsal-owner" {
		return fmt.Errorf("T%d's revision 2 is %+v, want %q with reason amend by rehearsal-owner", n, revision, text)
	}
	steers := 0
	for _, steer := range card.Steers {
		if steer.Text == text {
			steers++
		}
	}
	if steers != 1 {
		return fmt.Errorf("T%d records %d steers carrying the amendment, want 1", n, steers)
	}
	if card.State != "working" || card.PR != nil && card.PR.Number > 0 {
		return fmt.Errorf("T%d is %s with PR %+v after Amend, want working with no PR", n, card.State, card.PR)
	}
	after, err := r.j3Lane(n)
	if err != nil {
		return err
	}
	if after != before {
		return fmt.Errorf("Amend moved T%d from run %s attempt %d branch %s to run %s attempt %d branch %s", n, before.run, before.attempt, before.workspace, after.run, after.attempt, after.workspace)
	}
	is, err := numbers()
	if err != nil {
		return err
	}
	if !slices.Equal(is, was) {
		return fmt.Errorf("Amend changed the TODOs from %v to %v", was, is)
	}
	var facts int
	if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type = 'todo.amended' AND (data->>'n')::bigint = $1 AND (data->>'rev')::int = 2`, n).Scan(&facts); err != nil {
		return err
	}
	if facts != 1 {
		return fmt.Errorf("T%d has %d todo.amended facts for revision 2, want 1", n, facts)
	}
	r.actual = fmt.Sprintf("202 ×2 {n: %d, rev: 2}; revision 2 %q reason amend by %s; T%d +%d, %s on run %s attempt %d branch %s, no PR; TODOs %v unchanged; 1 todo.amended",
		n, text, card.PromptRevisions[1].By.Login, n, len(card.PromptRevisions)-1, card.State, after.run, after.attempt, after.workspace, is)
	return nil
}

// amendmentReachesRun is row 8: the amendment's steer is delivered to TODO
// n's run while its edit turn is held on [HOLD key]. Released, that turn
// finishes and the run's next implement turn (spec §10.7.3) carries the
// amendment in a user message, on the same run and attempt.
func (r *rehearsal) amendmentReachesRun(n int64, key, text string) error {
	if err := r.waitSQL(time.Minute, `SELECT count(*) FROM product_job_requests WHERE operation = 'flow.runtime.steer' AND state = 'completed'
		AND payload->'projection'->>'itemId' = (SELECT id::text FROM mythical_items WHERE number = $1)`, n); err != nil {
		return fmt.Errorf("the amendment's steer was not delivered to T%d's run: %w", n, err)
	}
	turns, err := r.modelTurns()
	if err != nil {
		return err
	}
	held := slices.IndexFunc(turns, func(turn map[string]any) bool { return turn["hold"] == key })
	if held < 0 {
		return fmt.Errorf("no model turn was held on [HOLD %s]", key)
	}
	var admitted time.Time
	if err := r.pool.QueryRow(r.ctx, `SELECT recorded_at FROM product_job_events WHERE event_type='todo.amended' AND (data->>'n')::bigint=$1 AND (data->>'rev')::int=2`, n).Scan(&admitted); err != nil {
		return err
	}
	before, err := r.j3Lane(n)
	if err != nil {
		return err
	}
	if err := r.release(key); err != nil {
		return err
	}
	for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(time.Second) {
		if turns, err = r.modelTurns(); err != nil {
			return err
		}
		// A held HTTP model request can time out and retry while an earlier
		// placement row waits. Pre-admission retries cannot consume this input.
		next, err := firstHeldTurnAfterAdmission(turns, key, admitted)
		if err != nil {
			return err
		}
		if next >= 0 {
			carried := false
			messages, _ := turns[next]["all"].([]any)
			for _, message := range messages {
				if m, ok := message.(map[string]any); ok && m["role"] == "user" && strings.Contains(fmt.Sprint(m["content"]), text) {
					carried = true
				}
			}
			if turns[next]["step"] != "coding/edit-atom" || !carried {
				return fmt.Errorf("T%d's next turn %d (%v) after its held edit does not carry the amendment in a user message", n, next+1, turns[next]["step"])
			}
			after, err := r.j3Lane(n)
			if err != nil {
				return err
			}
			if after != before {
				return fmt.Errorf("T%d's implement turn ran on run %s attempt %d, want %s attempt %d", n, after.run, after.attempt, before.run, before.attempt)
			}
			r.actual = fmt.Sprintf("steer delivered; held edit turn %d, then turn %d (%v) carries %q on run %s attempt %d", held+1, next+1, turns[next]["step"], text, after.run, after.attempt)
			return nil
		}
		v, err := r.todo(n)
		if err != nil {
			return err
		}
		if v.State == "in_review" || v.State == "dropped" || time.Now().After(deadline) {
			reached := "no later turn carries the amendment"
			if late := slices.IndexFunc(turns[held+1:], func(turn map[string]any) bool { return strings.Contains(turnText(turn), text) }); late >= 0 {
				reached = fmt.Sprintf("the amendment reaches turn %d (%v)", held+2+late, turns[held+1+late]["step"])
			}
			return fmt.Errorf("T%d is %s with no implement turn after its held edit; %s", n, v.State, reached)
		}
	}
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
	// Replacing a tracked file must replace its tree entry. mktree accepts
	// duplicates, but native JJ correctly rejects that malformed Git tree.
	entries := make([]string, 0)
	for _, entry := range strings.Split(listing, "\n") {
		_, name, found := strings.Cut(entry, "\t")
		if found && name != path {
			entries = append(entries, entry)
		}
	}
	entries = append(entries, "100644 blob "+blob+"\t"+path)
	tree, err := run(strings.Join(entries, "\n")+"\n", "mktree")
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

// The first dispatch after admission, never an arbitrary later matching turn.
func firstHeldTurnAfterAdmission(turns []map[string]any, key string, admitted time.Time) (int, error) {
	// The provider clock has millisecond precision. Use the lower bound so
	// rounding cannot silently skip the first post-admission dispatch.
	admitted = admitted.Truncate(time.Millisecond)
	for i, turn := range turns {
		if turn["hold"] != key {
			continue
		}
		stamp, ok := turn["dispatchAt"].(string)
		if !ok {
			return -1, fmt.Errorf("model turn %d has no dispatch timestamp", i+1)
		}
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			return -1, fmt.Errorf("model turn %d has an invalid dispatch timestamp: %w", i+1, err)
		}
		if !at.Before(admitted) {
			return i, nil
		}
	}
	return -1, nil
}

// Keep rows 17–20 independently runnable when an earlier placement row fails.
// The failed-attempt case includes ten worker passes and restart, stale and
// unresolved Done refusals, a real resolution write, and same-run publication.
func TestJ7RebaseConflictRows(t *testing.T) {
	if os.Getenv("SMITHERS_J7_REHEARSAL") != "1" {
		t.Skip("enable explicitly with SMITHERS_J7_REHEARSAL=1")
	}
	runJ7RebaseConflictRows(t)
}

func runJ7RebaseConflictRows(t *testing.T) (resolved, manual bool) {
	t.Helper()
	t.Setenv("SMITHERS_REBASE_REHEARSAL", "1")
	resolved = t.Run("Agent resolves the conflict", TestRebaseConflictRehearsal)
	manual = t.Run("Agent fails and a person completes the conflict", TestRebaseManualConflictRehearsal)
	return resolved, manual
}
