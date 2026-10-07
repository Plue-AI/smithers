package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// The candidate is seeded past machine verification. Publication, worker
// admission and the person's failed TODO card use the production composition.
// This is not the real-microVM C-STK-06 acceptance campaign.
func TestCandidateProtectedPolicyComposedInstall(t *testing.T) {
	t.Setenv("REHEARSAL_INSTALLATION_ID", "93")
	r := newRehearsal(t, "SMITHERS_STK12_REHEARSAL", "C-STK-06", "stk12-policy-", 25)
	r.stepBudget = 2 * time.Minute
	r.client.Timeout = 30 * time.Second
	require.True(t, r.setupSource())
	token, err := r.token("write:repository")
	require.NoError(t, err)
	work := filepath.Join(t.TempDir(), "candidate")
	_, err = r.gitDoor(token, "clone", "-q", r.origin+"/rehearsal-owner/app.git", work)
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Join(work, ".github", "workflows"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(work, ".github", "workflows", "untrusted.yml"), []byte("accepted change\n"), 0600))
	_, err = r.gitDoor(token, "-C", work, "add", ".github/workflows/untrusted.yml")
	require.NoError(t, err)
	_, err = r.gitDoor(token, "-C", work, "commit", "-q", "-m", "accepted lifecycle fixture")
	require.NoError(t, err)
	head, err := r.gitDoor(token, "-C", work, "rev-parse", "HEAD")
	require.NoError(t, err)
	_, err = r.gitDoor(token, "-C", work, "push", "-q", "origin", "HEAD:refs/heads/stk12-candidate")
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		var state string
		err := r.pool.QueryRow(r.ctx, `SELECT state FROM mythical_stacks`).Scan(&state)
		return err == nil && state == "active"
	}, 30*time.Second, 50*time.Millisecond)
	var repository, owner int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT repository_id,actor_user_id FROM mythical_stacks`).Scan(&repository, &owner))
	packCommand := exec.Command("/usr/bin/git", "-C", work, "pack-objects", "--stdout")
	packCommand.Stdin = strings.NewReader("")
	emptyPack, err := packCommand.Output()
	require.NoError(t, err)
	keep := repohost.MythicalReservedRefNS + "keep/" + head
	update := strings.Repeat("0", 40) + " " + head + " " + keep + "\x00report-status\n"
	body := bytes.NewBufferString(fmt.Sprintf("%04x%s0000", len(update)+4, update))
	_, err = body.Write(emptyPack)
	require.NoError(t, err)
	var retained bytes.Buffer
	require.NoError(t, r.repoClient.ProxyReceivePack(r.ctx, "rehearsal-owner", "app", body, &retained, repohost.ReceivePackMetadata{RepositoryID: repository, ControlPlane: true, PusherLogin: "fixture"}))
	require.Contains(t, retained.String(), "ok "+keep)

	var number int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `INSERT INTO mythical_items(repository_id,source,state,issue_title,title,revisions,owner_id,candidate_base,candidate_head,candidate_verified,outsider,attempt,checks)
 VALUES ($1,'todo','proposing','Untrusted workflow','Untrusted workflow','[{"rev":1,"text":"change workflow","acceptance":["passes"]}]',$2,$3,$4,true,true,1,'{}') RETURNING number`, repository, owner, r.mainCommit, head).Scan(&number))
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_stacks SET requested_generation=requested_generation+1,next_attempt_at=NOW() WHERE repository_id=$1`, repository)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		status, data, err := r.request("GET", fmt.Sprintf("/api/todos/%d", number), "")
		if err != nil || status != 200 {
			return false
		}
		var card struct {
			State string `json:"state"`
		}
		return json.Unmarshal(data, &card) == nil && card.State == "failed"
	}, 30*time.Second, 50*time.Millisecond)
	var state, reason, published string
	var pending []byte
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT state,reason,pr_head,pending_op FROM mythical_items WHERE number=$1`, number).Scan(&state, &reason, &published, &pending))
	require.Equal(t, "blocked", state)
	require.Equal(t, "a maintainer changes protected paths: .github/workflows/untrusted.yml", reason)
	require.Empty(t, published)
	require.Empty(t, pending)
	branches, err := r.gitDoor(token, "--git-dir", filepath.Join(r.gitRoot, "rehearsal-owner", "app.git"), "for-each-ref", "--format=%(refname)", "refs/heads/smithers/")
	require.NoError(t, err)
	require.Empty(t, branches, "the fake GitHub received no TODO branch")

	// A retained check's factory classification must not turn a tree-writing
	// failure into an automatic replan. Project through the production runtime
	// boundary, let the composed worker settle it, then read the person's card.
	for _, codeOnly := range []bool{false, true} {
		var id string
		var generation int32
		require.NoError(t, r.pool.QueryRow(r.ctx, `INSERT INTO mythical_items(repository_id,source,state,issue_title,title,revisions,owner_id,candidate_base,candidate_head,candidate_verified,attempt,verify_run_id,checks)
 VALUES ($1,'todo','verifying','Writing check','Writing check','[{"rev":1,"text":"check change","acceptance":["passes"]}]',$2,$3,$4,false,1,'writing-check','{}') RETURNING id::text,number,generation`, repository, owner, r.mainCommit, head).Scan(&id, &number, &generation))
		projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": id, "generation": generation, "attempt": 1, "phase": "verify"})
		require.NoError(t, err)
		checkpoint := flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "writing-check", Run: &flowruntime.FlowRuntimeRun{RunID: "writing-check", FailureFault: "factory", FailureTag: "coding/Error/check_modified_tree"}}
		if codeOnly {
			checkpoint.Run = nil
			checkpoint.FailureCode = "check_modified_tree"
		}
		projector := services.NewMythicalService(r.pool, nil)
		require.NoError(t, projector.ProjectFlowRuntime(r.ctx, flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Checkpoint: checkpoint}))
		require.Eventually(t, func() bool {
			status, data, err := r.request("GET", fmt.Sprintf("/api/todos/%d", number), "")
			var card struct {
				State string `json:"state"`
			}
			return err == nil && status == 200 && json.Unmarshal(data, &card) == nil && card.State == "failed"
		}, 30*time.Second, 50*time.Millisecond)
		var attempt int32
		var verified bool
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT state,reason,pr_head,pending_op,attempt,candidate_verified FROM mythical_items WHERE id=$1`, id).Scan(&state, &reason, &published, &pending, &attempt, &verified))
		require.Equal(t, "blocked", state)
		require.Contains(t, reason, "check_modified_tree")
		require.EqualValues(t, 1, attempt)
		require.False(t, verified)
		require.Empty(t, published)
		require.Empty(t, pending)
		// Replaying the failed checkpoint must not allocate another attempt.
		require.NoError(t, projector.ProjectFlowRuntime(r.ctx, flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Checkpoint: checkpoint}))
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT state,attempt FROM mythical_items WHERE id=$1`, id).Scan(&state, &attempt))
		require.Equal(t, "blocked", state)
		require.EqualValues(t, 1, attempt)
	}
	branches, err = r.gitDoor(token, "--git-dir", filepath.Join(r.gitRoot, "rehearsal-owner", "app.git"), "for-each-ref", "--format=%(refname)", "refs/heads/smithers/")
	require.NoError(t, err)
	require.Empty(t, branches)
}
