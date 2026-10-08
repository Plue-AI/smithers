package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Real install admission, file writes, source TODO continuation, native fork
// daemon and repository publication. This is trusted-process evidence only.
func TestScratchRebaseFromTodoRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_SCRATCH_REBASE_REHEARSAL", "T-STK-08", "scratch-rebase-")
	if !r.setupSource() || !r.setupMachine() {
		return
	}
	var source int64
	var scratch services.BranchMachineResponse
	var onto, main, originalRoot string
	var attempt int32
	readRef := func(ref string) (string, error) {
		path := (repohostserver.Config{StoragePath: r.repositoryRoot}).RepoPath("rehearsal-owner", "app")
		out, err := hostexec.Git(r.ctx, "-C", filepath.Join(path, ".jj/repo/store/git"), "rev-parse", ref).Output()
		return strings.TrimSpace(string(out)), err
	}
	if !r.step("Fork the source TODO", "TODO; POST /api/branches; PUT branch file", "Scratch retains its fork source and a member edit", "T-STK-08", func() error {
		if err := r.waitStackActive(); err != nil {
			return err
		}
		var err error
		source, err = r.file("Source", "[PR] [FILE source.md] Add the source note.")
		if err != nil {
			return err
		}
		if _, err = r.waitTodoWithin(source, j10RunWait, "in_review"); err != nil {
			return err
		}
		if err = r.pool.QueryRow(r.ctx, `SELECT request_run_id,attempt FROM mythical_items WHERE number=$1`, source).Scan(&originalRoot, &attempt); err != nil {
			return err
		}
		body, err := r.expect("POST", "/api/branches", fmt.Sprintf(`{"from":"T%d","name":"try-rebase"}`, source), 201)
		if err != nil {
			return err
		}
		if err = json.Unmarshal(body, &scratch); err != nil {
			return err
		}
		if scratch.ForkedFrom == nil || scratch.ForkedFrom.Item != source {
			return fmt.Errorf("fork lost its TODO source")
		}
		_, err = r.expect("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+scratch.Machine.ID+"/files/content?path=scratch.md", `{"base_digest":"absent","content":"keep the whole Scratch delta\n"}`, 200)
		return err
	}) {
		return
	}
	if !r.step("The source moves", "Steer the source TODO", "same source run; source current head differs from main", "T-STK-08", func() error {
		var err error
		var review string
		if err = r.waitSQL(j10RunWait, `SELECT count(*) FROM mythical_items WHERE number=$1 AND state='proposed' AND COALESCE(checks->'review'->>'runId','')<>'' AND COALESCE((checks->'review'->>'posted')::boolean,false)`, source); err != nil {
			return err
		}
		if err = r.pool.QueryRow(r.ctx, `SELECT checks->'review'->>'runId' FROM mythical_items WHERE number=$1`, source).Scan(&review); err != nil {
			return err
		}
		_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", source), `{"steer":"[PR] [FILE source.md] Improve the source note."}`, 202)
		if err != nil {
			return err
		}
		if _, err = r.waitTodoWithin(source, j10RunWait, "in_review"); err != nil {
			return err
		}
		if err = r.waitSQL(j10RunWait, `SELECT count(*) FROM mythical_items WHERE number=$1 AND state='proposed' AND checks->'review'->>'runId'<>$2 AND COALESCE((checks->'review'->>'posted')::boolean,false)`, source, review); err != nil {
			return err
		}
		return r.pool.QueryRow(r.ctx, `SELECT w.head_commit_id,s.landed_main FROM workspaces w JOIN mythical_stacks s ON s.repository_id=w.repository_id WHERE w.id=$1`, scratch.Machine.ParentWorkspaceID).Scan(&onto, &main)
	}) {
		return
	}
	r.step("Rebase the Scratch", "POST /api/branches; GET bound receipt; GET branch files", "fork source current head; whole delta; zero new TODOs or coding attempts; main unchanged", "T-STK-08", func() error {
		path := "/api/branches/" + url.PathEscape(scratch.Name)
		body, err := r.expect("GET", path, "", 200)
		if err != nil {
			return err
		}
		var card services.BranchMachineResponse
		if err = json.Unmarshal(body, &card); err != nil {
			return err
		}
		if card.Rebase["onto"] != fmt.Sprintf("T%d", source) || card.Rebase["state"] != "pending" {
			return fmt.Errorf("Scratch card has no current source rebase")
		}
		request := "scratch-source-once"
		if os.Getenv("SMITHERS_GH03_BROWSER_HARNESS") != "" {
			githubLifecycleBrowserPhase(t, r, source, "scratch_pending", map[string]any{"scratchName": scratch.Name})
			if err = r.pool.QueryRow(r.ctx, `SELECT authorization_context->'scratch_rebase'->>'request' FROM product_job_requests WHERE operation='branch.rebase-requested' AND principal_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, "branch:"+scratch.Machine.ID).Scan(&request); err != nil {
				return err
			}
		} else {
			code, _, err := r.keyed("POST", path, `{"rebase":true}`, request)
			if err != nil {
				return err
			}
			if code != 202 {
				return fmt.Errorf("Scratch rebase admission HTTP %d", code)
			}
		}
		// Native acknowledgement can precede its SQL head projection. Bind
		// this assertion to the authoritative source ref used by admission.
		onto, err = readRef(repohost.BranchHeadRef(scratch.Machine.ParentWorkspaceID))
		if err != nil {
			return err
		}
		deadline := time.Now().Add(3 * time.Minute)
		for {
			body, err = r.expect("GET", path+"?rebase_request="+url.QueryEscape(request), "", 200)
			if err != nil {
				return err
			}
			if err = json.Unmarshal(body, &card); err != nil {
				return err
			}
			if card.RebaseExecution != nil && card.RebaseExecution.State == "completed" {
				break
			}
			if card.RebaseExecution != nil && card.RebaseExecution.State == "failed" {
				return fmt.Errorf("Scratch rebase failed")
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("Scratch rebase did not publish")
			}
			time.Sleep(time.Second)
		}
		if card.RebaseExecution.Onto != onto || onto == main {
			return fmt.Errorf("Scratch rebased onto main instead of its source")
		}
		parent, err := readRef("refs/heads/" + scratch.Name + "^")
		if err != nil {
			return err
		}
		if parent != onto {
			return fmt.Errorf("Scratch published a different source parent")
		}
		for _, file := range []string{"source.md", "scratch.md"} {
			if _, err = r.expect("GET", path+"/files/"+file, "", 200); err != nil {
				return err
			}
		}
		body, err = r.expect("GET", path+"/files/source.md", "", 200)
		if err != nil {
			return err
		}
		var contents struct{ Content struct{ Text string } }
		if err = json.Unmarshal(body, &contents); err != nil {
			return err
		}
		if strings.Count(contents.Content.Text, "Hello from Smithers!") < 2 {
			return fmt.Errorf("Scratch lost the source's later edit")
		}
		var count int
		var root, currentMain string
		var currentAttempt int32
		if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items`).Scan(&count); err != nil {
			return err
		}
		require.Equal(t, 1, count)
		if err = r.pool.QueryRow(r.ctx, `SELECT i.request_run_id,i.attempt,s.landed_main FROM mythical_items i JOIN mythical_stacks s ON s.repository_id=i.repository_id WHERE number=$1`, source).Scan(&root, &currentAttempt, &currentMain); err != nil {
			return err
		}
		if root != originalRoot || currentAttempt != attempt || currentMain != main {
			return fmt.Errorf("Scratch changed the source attempt or main")
		}
		githubLifecycleBrowserPhase(t, r, source, "scratch_rebased", map[string]any{"scratchName": scratch.Name})
		return nil
	})
}
