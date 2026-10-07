package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Real PostgreSQL, Git objects, stack poller and durable flow admission. The
// terminal runtime projection is a fixture: this proves intent/ownership and
// recovery, not that a real machine executed the checks.
func TestCapturedEditsContinueSameAttempt(t *testing.T) {
	f := newRebaseFixture(t)
	item := f.candidate("Keep member edits", f.main, "AGENT.md", "agent work\n")
	pool := f.pool.(*pgxpool.Pool)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("admission must not contact a runtime")
		return nil, errors.New("no runtime")
	})})
	require.NoError(t, err)
	f.service.SetLauncher(dispatcher)
	capturedHead := f.commit("member edits", "MEMBER.md", "kept member edits\n")
	capturedTree := f.git(f.work, "rev-parse", capturedHead+"^{tree}")
	capture := MachineCapturePending{Head: capturedHead, Tree: capturedTree, Base: item.CandidateHead, Onto: capturedHead}
	f.git(f.work, "push", "-q", f.hostDir, capturedHead+":refs/smithers/branches/"+item.WorkspaceID+"/captures/"+capturedHead)
	branchRef := "refs/smithers/branches/" + item.WorkspaceID + "/head"
	f.git(f.work, "push", "-q", f.hostDir, capturedHead+":"+branchRef)
	raw, _ := json.Marshal(capture)
	_, err = pool.Exec(t.Context(), `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status,head_commit_id,capture_pending) VALUES($1,$2,$3,'capture','capture-vm','running',$4,$5)`, item.WorkspaceID, f.repoID, f.userID, capturedHead, raw)
	require.NoError(t, err)
	item.FlowDigest = pgtype.Text{String: todoPinOne, Valid: true}
	item.RequestRunID = "same-composition"
	item.CandidateVerified = false
	checks := mythicalChecksOf(item)
	checks.FlowSource = f.main
	checks.Capture = &capture
	checks.Review = &mythicalReview{Head: item.CandidateHead, Candidate: item.CandidateHead, Verdict: "approve"}
	item.Checks = checks.encode()
	item, err = db.New(pool).SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	count := func(want int) {
		t.Helper()
		var count int
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&count))
		require.Equal(t, want, count)
	}
	pending := func(want bool) {
		t.Helper()
		var present bool
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT capture_pending IS NOT NULL FROM workspaces WHERE id=$1`, item.WorkspaceID).Scan(&present))
		require.Equal(t, want, present)
	}
	// Refuse the durable launch after saving the generation. The whole domain
	// transition and capture consumption must roll back with that failure.
	_, err = pool.Exec(t.Context(), `ALTER TABLE product_job_requests ADD CONSTRAINT reject_capture_verify CHECK (operation <> 'flow.runtime.launch') NOT VALID`)
	require.NoError(t, err)
	f.wake()
	failed := f.item(item.Number.Int64)
	require.Equal(t, item.Generation, failed.Generation)
	require.Equal(t, item.CandidateHead, failed.CandidateHead)
	require.NotNil(t, mythicalChecksOf(failed).Capture)
	pending(true)
	count(0)
	_, err = pool.Exec(t.Context(), `ALTER TABLE product_job_requests DROP CONSTRAINT reject_capture_verify`)
	require.NoError(t, err)
	// Native publication survived a rolled-back projection: SQL still names
	// the old capture. Do not consume it or launch stale checks.
	newer := f.commit("newer member edits", "MEMBER.md", "newer member edits\n")
	f.git(f.work, "push", "-q", f.hostDir, newer+":"+branchRef)
	f.wake()
	pending(true)
	count(0)
	held := f.item(item.Number.Int64)
	require.Equal(t, item.Generation, held.Generation)
	require.Equal(t, item.CandidateHead, held.CandidateHead)
	// Restore the fixture's published head to complete this continuation.
	f.git(f.work, "push", "-q", f.hostDir, "+"+capturedHead+":"+branchRef)
	f.wake()
	next := f.item(item.Number.Int64)
	require.Equal(t, "verifying", next.State, next.Reason)
	require.Equal(t, item.Attempt, next.Attempt)
	require.Equal(t, item.RequestRunID, next.RequestRunID)
	require.Equal(t, item.WorkspaceID, next.WorkspaceID)
	require.Equal(t, item.FlowDigest, next.FlowDigest)
	require.Equal(t, item.Generation+1, next.Generation)
	require.Equal(t, capturedHead, next.CandidateHead)
	require.False(t, next.CandidateVerified)
	require.Nil(t, mythicalChecksOf(next).Capture)
	require.Nil(t, mythicalChecksOf(next).Review, "edited bytes always need a fresh review")
	pending(false)
	count(1)
	evidence := todoEvidence(next)
	require.Len(t, evidence, 1)
	require.NotNil(t, evidence[0].Previous)
	require.Equal(t, item.CandidateHead, evidence[0].Previous.Revision)
	require.Equal(t, capturedHead, evidence[0].Revision)
	var payload struct {
		FlowID     string           `json:"flowId"`
		Pin        *flowruntime.Pin `json:"pin"`
		Projection json.RawMessage  `json:"projection"`
		Payload    json.RawMessage  `json:"payload"`
	}
	var launch []byte
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT payload FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&launch))
	require.NoError(t, json.Unmarshal(launch, &payload))
	require.Equal(t, "coding/verify", payload.FlowID)
	require.NotNil(t, payload.Pin)
	require.Equal(t, todoPinOne, payload.Pin.ExecutionDigest)
	require.Equal(t, f.main, payload.Pin.SourceCommit)
	require.Contains(t, string(payload.Payload), capturedHead)
	var consumed int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.capture_consumed'`).Scan(&consumed))
	require.Equal(t, 1, consumed)
	f.wake()
	count(1)
	// A late successful receipt from the previous generation cannot approve
	// the captured candidate. Its own receipt only becomes verified on poll.
	var projection mythicalProjection
	require.NoError(t, json.Unmarshal(payload.Projection, &projection))
	output := `{"status":"passed","failed":[],"receipts":[]}`
	project := func(generation int64) {
		p := projection
		p.Generation = generation
		raw, _ := json.Marshal(p)
		require.NoError(t, f.service.ProjectFlowRuntime(t.Context(), flowdispatch.ProjectionUpdate{State: jobs.StateCompleted, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: raw, FlowID: "coding/verify", ExecutionDigest: todoPinOne, RunID: "verify-capture", Run: &flowruntime.FlowRuntimeRun{RunID: "verify-capture", FinalOutput: &output}}}))
	}
	project(item.Generation)
	require.Empty(t, f.item(item.Number.Int64).VerifyOutcome)
	project(next.Generation)
	require.Equal(t, "passed", f.item(item.Number.Int64).VerifyOutcome)
	f.wake()
	verified := f.item(item.Number.Int64)
	require.True(t, verified.CandidateVerified, verified.Reason)
	require.Equal(t, capturedHead, verified.CandidateHead)
	require.Equal(t, item.Attempt, verified.Attempt)
	require.Equal(t, "kept member edits", strings.TrimSpace(f.git(f.hostDir, "show", capturedHead+":MEMBER.md")))
}

// Tree identity alone does not prove that the captured snapshot still includes
// the stack prefix. Neither malformed identity nor unrelated history may run.
func TestCapturedContinuationChecksSnapshotBeforeLaunch(t *testing.T) {
	f := newRebaseFixture(t)
	item := f.candidate("Snapshot ancestry", f.main, "AGENT.md", "agent work\n")
	head := f.commit("member edits", "MEMBER.md", "member work\n")
	tree := f.git(f.work, "rev-parse", head+"^{tree}")
	orphan := f.git(f.work, "commit-tree", tree, "-m", "unrelated history")
	branchRef := "refs/smithers/branches/" + item.WorkspaceID + "/head"
	for _, commit := range []string{head, orphan} {
		f.git(f.work, "push", "-q", f.hostDir, commit+":refs/smithers/branches/"+item.WorkspaceID+"/captures/"+commit)
	}
	_, err := f.pool.Exec(t.Context(), `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status) VALUES($1,$2,$3,'snapshot','snapshot-vm','running')`, item.WorkspaceID, f.repoID, f.userID)
	require.NoError(t, err)
	for _, name := range []string{"unrelated history", "wrong tree", "valid"} {
		t.Run(name, func(t *testing.T) {
			capture := MachineCapturePending{Head: head, Tree: tree, Base: item.CandidateHead, Onto: head}
			if name == "unrelated history" {
				capture.Head = orphan
				capture.Onto = orphan
			}
			if name == "wrong tree" {
				capture.Tree = f.git(f.work, "rev-parse", f.main+"^{tree}")
			}
			f.git(f.work, "push", "-q", f.hostDir, "+"+capture.Head+":"+branchRef)
			current := f.item(item.Number.Int64)
			current.FlowDigest = pgtype.Text{String: todoPinOne, Valid: true}
			current.CandidateVerified = false
			checks := mythicalChecksOf(current)
			checks.FlowSource = f.main
			checks.Capture = &capture
			current.Checks = checks.encode()
			_, err := db.New(f.pool).SaveMythicalItem(t.Context(), current)
			require.NoError(t, err)
			raw, _ := json.Marshal(capture)
			_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET head_commit_id=$2,capture_pending=$3 WHERE id=$1`, item.WorkspaceID, capture.Head, raw)
			require.NoError(t, err)
			f.wake()
			next := f.item(item.Number.Int64)
			if name == "valid" {
				require.Equal(t, 1, f.verifies(item))
				require.Equal(t, head, next.CandidateHead)
				require.Equal(t, item.Generation+1, next.Generation)
				require.Nil(t, mythicalChecksOf(next).Capture)
			} else {
				require.Zero(t, f.verifies(item))
				require.Equal(t, item.CandidateHead, next.CandidateHead)
				require.Equal(t, item.Generation, next.Generation)
				require.NotNil(t, mythicalChecksOf(next).Capture)
			}
		})
	}
}

// The reserved transport retains work in the existing source namespace. Only
// the production worker's owning claim can pin it, allocate a generation, and
// launch checks; no candidate head is accepted by the HTTP admission write.
func TestReservedSourceCaptureContinuesUnderOwningClaim(t *testing.T) {
	for _, moved := range []bool{false, true} {
		for _, equal := range []bool{false, true} {
			t.Run(fmt.Sprintf("prefix_moved_%t_equal_tree_%t", moved, equal), func(t *testing.T) {
				testReservedSourceCapture(t, moved, equal)
			})
		}
	}
}

func testReservedSourceCapture(t *testing.T, moved, equal bool) {
	f := newRebaseFixture(t)
	item := f.candidate("Reserved snapshot", f.main, "AGENT.md", "agent work\n")
	pool := f.pool.(*pgxpool.Pool)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("admission contacted runtime")
		return nil, errors.New("no runtime")
	})})
	require.NoError(t, err)
	f.service.SetLauncher(dispatcher)
	head := item.CandidateHead
	if equal {
		f.git(f.work, "commit", "-q", "--allow-empty", "-m", "seal equal native snapshot")
		head = f.git(f.work, "rev-parse", "HEAD")
	} else {
		head = f.commit("reserved capture", "MEMBER.md", "reserved bytes\n")
	}
	tree := f.git(f.work, "rev-parse", head+"^{tree}")
	ref := "refs/smithers/workspaces/" + item.WorkspaceID + "/sources/" + head
	f.git(f.work, "push", "-q", f.hostDir, head+":"+ref)
	capture := MachineCapturePending{Head: head, Tree: tree, Base: item.CandidateHead, Onto: head, SourceRef: ref}
	raw, _ := json.Marshal(capture)
	_, err = pool.Exec(t.Context(), `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status,head_commit_id,capture_pending) VALUES($1,$2,$3,'reserved','reserved-vm','running',$4,$5)`, item.WorkspaceID, f.repoID, f.userID, head, raw)
	require.NoError(t, err)
	item.FlowDigest = pgtype.Text{String: todoPinOne, Valid: true}
	item.RequestRunID = "same-composition"
	item.CandidateVerified = false
	checks := mythicalChecksOf(item)
	checks.FlowSource = f.main
	checks.Capture = &capture
	item.Checks = checks.encode()
	item, err = db.New(pool).SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	// A predecessor lands while the immutable capture is pending. The
	// same owning claim rebases retained bytes; it never rewrites the guest.
	onto := item.CandidateBase
	if moved {
		f.git(f.work, "checkout", "-q", f.main)
		if equal {
			f.git(f.work, "commit", "-q", "--allow-empty", "-m", "prefix metadata advances")
			onto = f.git(f.work, "rev-parse", "HEAD")
		} else {
			onto = f.commit("prefix advances", "PREFIX.md", "prefix bytes\n")
		}
		f.git(f.work, "push", "-q", f.hostDir, onto+":refs/heads/main", onto+":refs/smithers/mythical/keep/"+onto)
		_, err = pool.Exec(t.Context(), `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, f.repoID, onto)
		require.NoError(t, err)
	}
	// A crash before the combined generation/launch commit preserves pending bytes.
	_, err = pool.Exec(t.Context(), `ALTER TABLE product_job_requests ADD CONSTRAINT reject_reserved_verify CHECK (operation <> 'flow.runtime.launch') NOT VALID`)
	require.NoError(t, err)
	f.wake()
	before := f.item(item.Number.Int64)
	require.Equal(t, item.Generation, before.Generation)
	require.Equal(t, item.CandidateHead, before.CandidateHead)
	require.NotNil(t, mythicalChecksOf(before).Capture)
	_, err = pool.Exec(t.Context(), `ALTER TABLE product_job_requests DROP CONSTRAINT reject_reserved_verify`)
	require.NoError(t, err)
	f.wake()
	next := f.item(item.Number.Int64)
	require.Equal(t, "verifying", next.State, next.Reason)
	require.Equal(t, item.Generation+1, next.Generation)
	require.Equal(t, onto, next.CandidateBase)
	if moved {
		require.NotEqual(t, head, next.CandidateHead)
		if !equal {
			require.Equal(t, "prefix bytes", strings.TrimSpace(f.git(f.hostDir, "show", next.CandidateHead+":PREFIX.md")))
		}
	} else {
		require.Equal(t, head, next.CandidateHead)
	}
	require.False(t, next.CandidateVerified)
	require.Nil(t, mythicalChecksOf(next).Capture)
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&count))
	require.Equal(t, 1, count)
	if equal {
		require.Equal(t, tree, f.git(f.hostDir, "rev-parse", next.CandidateHead+"^{tree}"))
		require.Equal(t, "agent work", strings.TrimSpace(f.git(f.hostDir, "show", next.CandidateHead+":AGENT.md")))
	} else {
		require.Equal(t, "reserved bytes", strings.TrimSpace(f.git(f.hostDir, "show", next.CandidateHead+":MEMBER.md")))
	}
	f.wake()
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&count))
	require.Equal(t, 1, count)
}
