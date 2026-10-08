package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestRebaseManualConflictRehearsal(t *testing.T) { testRebaseManualConflictRehearsal(t, 1) }

func TestRebaseZeroConflictAttemptsRehearsal(t *testing.T) { testRebaseManualConflictRehearsal(t, 0) }

func testRebaseManualConflictRehearsal(t *testing.T, limit int) {
	if os.Getenv("SMITHERS_REBASE_DONE_BROWSER") == "1" && os.Getenv("SMITHERS_REHEARSAL_SPA_DIR") == "" {
		_, source, _, _ := runtime.Caller(0)
		t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", filepath.Join(filepath.Dir(source), "../../../../apps/app/dist"))
	}
	r := newRehearsal(t, "SMITHERS_REBASE_REHEARSAL", "C-J7-03", "manual-rebase-")
	if !r.setupSource() || !r.setupMachine() {
		return
	}
	if err := db.New(r.pool).UpsertInstallSetting(r.ctx, db.UpsertInstallSettingParams{Key: services.InstallCodingProjectKey, Value: []byte(fmt.Sprintf(`{"conflictAttempts":%d}`, limit))}); err != nil {
		t.Fatal(err)
	}
	var n int64
	var rootRun, initialReview string
	var attempt int32
	if !r.step("Reviewed TODO", "POST /api/todos", "In review with a PR", "T-STK-08", func() error {
		if err := r.waitStackActive(); err != nil {
			return err
		}
		var err error
		n, err = r.file("First TODO", "[NORESOLVE] Add a greeting to JOURNEY.md")
		if err != nil {
			return err
		}
		if _, err = r.waitTodoWithin(n, j10RunWait, "in_review"); err != nil {

			return err
		}
		if err := r.waitSQL(j10RunWait, `SELECT count(*) FROM mythical_items WHERE number=$1 AND checks->'review'->>'verdict' IN ('approve','request-changes') AND COALESCE(checks->'review'->>'runId','')<>''`, n); err != nil {
			return err
		}
		return r.pool.QueryRow(r.ctx, `SELECT request_run_id,attempt,checks->'review'->>'runId' FROM mythical_items WHERE number=$1`, n).Scan(&rootRun, &attempt, &initialReview)
	}) {
		return
	}
	r.step("A person resolves the retained conflict", "Rebase now; restart; file write; Branch Done", fmt.Sprintf("%d agent attempts; unresolved/stale Done 409; one continuation and the same PR", limit), "T-STK-08", func() error {
		called := false
		_, err := r.rebaseBranchWithMain(n, true, "JOURNEY.md", "Greeting from new main\n", func(card rehearsalTodo, onto string) error {
			called = true
			countTurns := func() error {
				var turns struct {
					Steps map[string]int `json:"steps"`
				}
				if err := json.Unmarshal([]byte(r.coder.turns()), &turns); err != nil {
					return err
				}
				count := turns.Steps["conflict/resolve"] + turns.Steps["conflict/noresolve"]
				if count != limit {
					return fmt.Errorf("conflict agent turns=%d, want %d", count, limit)
				}
				return nil
			}
			if err := countTurns(); err != nil {
				return err
			}
			r.restartBackend()
			var repository int64
			if err := r.pool.QueryRow(r.t.Context(), `SELECT repository_id FROM mythical_items WHERE number=$1 AND checks->>'branch'=$2`, n, card.Branch.Name).Scan(&repository); err != nil {
				return err
			}
			for range 10 {
				if _, err := db.New(r.pool).RequestMythicalStack(r.t.Context(), repository); err != nil {
					return err
				}
				stack, err := db.New(r.pool).GetMythicalStack(r.t.Context(), repository)
				if err != nil {
					return err
				}
				if err := r.waitSQL(30*time.Second, `SELECT count(*) FROM mythical_stacks WHERE repository_id=$1 AND processed_generation >= $2`, repository, stack.RequestedGeneration); err != nil {
					return err
				}
				held, err := r.todo(n)
				if err != nil {
					return err
				}
				if held.State != "needs_you" {
					return fmt.Errorf("restart/poll lost conflict wait: %s", held.State)
				}
			}
			if err := countTurns(); err != nil {
				return err
			}
			raw, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", n), "", 200)
			if err != nil {
				return err
			}
			var view struct {
				Waits []struct {
					Kind   string
					Change string `json:"conflict_change"`
					Onto   string `json:"onto_revision"`
					Paths  []string
				}
			}
			if err = json.Unmarshal(raw, &view); err != nil {
				return err
			}
			var change string
			for _, wait := range view.Waits {
				if wait.Kind == "conflict" && wait.Onto == onto && slices.Contains(wait.Paths, "JOURNEY.md") {
					change = wait.Change
				}
			}
			if change == "" {
				return fmt.Errorf("the real wait lacks its retained native binding/paths")
			}
			branchPath := "/api/branches/" + url.PathEscape(card.Branch.ID)
			done := func(binding string, status int) error {
				body, _ := json.Marshal(map[string]string{"conflict_change": binding, "onto_revision": onto})
				_, err := r.expect("POST", branchPath, string(body), status)
				return err
			}
			if err := done("stale-change", 409); err != nil {
				return err
			}
			if err := done(change, 409); err != nil {
				return err
			}
			if os.Getenv("SMITHERS_GH03_BROWSER_HARNESS") != "" {
				githubLifecycleBrowserPhase(t, r, n, "conflict", map[string]any{"branchId": card.Branch.ID})
				if err := done(change, 202); err != nil {
					return err
				}
				return countTurns()
			}
			if os.Getenv("SMITHERS_REBASE_DONE_BROWSER") == "1" {
				if err := r.runRebaseBrowser(n, "rebase-done", "journey-rebase-done"); err != nil {
					return err
				}
				if err := done(change, 202); err != nil {
					return err
				}
				return countTurns()
			}
			filePath := "/api/repos/rehearsal-owner/app/workspaces/" + card.Branch.ID + "/files/content?path=JOURNEY.md"
			raw, err = r.expect("GET", filePath, "", 200)
			if err != nil {
				return err
			}
			var file struct{ Digest string }
			if err = json.Unmarshal(raw, &file); err != nil {
				return err
			}
			body, _ := json.Marshal(map[string]string{"base_digest": file.Digest, "content": "Greeting from new main\nHello from Smithers!\n"})
			if _, err = r.expect("PUT", filePath, string(body), 200); err != nil {
				return err
			}
			if err := done(change, 202); err != nil {
				return err
			}
			if err := done(change, 202); err != nil {
				return err
			}
			return countTurns()
		})
		if err != nil {
			return err
		}
		if !called {
			return fmt.Errorf("the retained conflict never reached a person's wait")
		}
		if err := r.waitSQL(j10RunWait, `SELECT count(*) FROM mythical_items WHERE number=$1 AND checks->'review'->>'verdict' IN ('approve','request-changes') AND COALESCE(checks->'review'->>'runId','')<>'' AND checks->'review'->>'runId'<>$2`, n, initialReview); err != nil {
			return err
		}
		var continuedRun, continuedReview string
		var continuedAttempt int32
		if err := r.pool.QueryRow(r.ctx, `SELECT request_run_id,attempt,checks->'review'->>'runId' FROM mythical_items WHERE number=$1`, n).Scan(&continuedRun, &continuedAttempt, &continuedReview); err != nil {
			return err
		}
		if continuedRun != rootRun || continuedAttempt != attempt {
			return fmt.Errorf("manual resolution changed the pinned attempt: %s/%d -> %s/%d", rootRun, attempt, continuedRun, continuedAttempt)
		}
		if continuedReview == "" || continuedReview == initialReview {
			return fmt.Errorf("resolved conflict did not receive a new review")
		}
		githubLifecycleBrowserPhase(t, r, n, "reviewed", nil)
		return nil
	})
}
