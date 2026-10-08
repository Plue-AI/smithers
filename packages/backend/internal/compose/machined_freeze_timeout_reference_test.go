package compose

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Unlike the synthetic Linux deadline controls, this crosses the person HTTP
// door, persisted scheduler, real broker and kernel D-state blocker together.
// The owner provisions the fixed dm-delay file in the approved guest image,
// owned by the install owner's allocated UID, with >=30 s write delay. No test
// creates a device, changes a cgroup or installs privileged checkout code.
func TestMachinedFreezeTimeoutComposedReference(t *testing.T) {
	if os.Getenv("SMITHERS_MACHINED_FREEZE_TIMEOUT_REFERENCE") != "1" {
		if os.Getenv("SMITHERS_MACHINED_FREEZE_TIMEOUT_REQUIRED") == "1" {
			t.Fatal("approved reference VM and owner-provisioned dm-delay fixture required")
		}
		t.Skip("approved reference VM and owner-provisioned dm-delay fixture required")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	require.NotZero(t, os.Geteuid())
	t.Setenv(pinnedMicroVMRehearsal, "1")
	r := newRehearsal(t, pinnedMicroVMRehearsal, "C-COL-03", "freeze-timeout-")
	require.False(t, r.options.LiveCodeDocuments)
	vm, ok := r.workspaceRuntime.(*microsandbox.Runtime)
	require.True(t, ok)
	require.True(t, r.install("Install through Machine ready"))
	n, err := r.file("Freeze timeout recovery", "Add a greeting to JOURNEY.md")
	require.NoError(t, err)
	before, err := r.waitTodoWithin(n, 15*time.Minute, "in_review")
	require.NoError(t, err)
	require.NotNil(t, before.Branch)
	branch, _, err := r.todoHostBinding(n)
	require.NoError(t, err)
	registry := vm.MachinedRegistry()
	link, err := registry.Current(branch)
	require.NoError(t, err)
	q := db.New(r.pool)
	row, err := q.GetWorkspace(r.ctx, branch)
	require.NoError(t, err)
	owner, err := q.GetSelfHostOwner(r.ctx)
	require.NoError(t, err)
	var user machined.SessionUser
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT unix_login,unix_uid FROM collaborators WHERE repository_id=$1 AND user_id=$2`, row.RepositoryID, owner.ID).Scan(&user.Login, &user.UID))
	actor, err := machined.CommitActor(r.ctx, r.pool, branch, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: owner.ID, Via: "terminal"}, nil
	})
	require.NoError(t, err)
	sessions := machined.NewSessions(link.Connection, branch, registry.Sessions(branch)).WithActor(actor, "").WithPresenceVia("terminal")
	command := func(script string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(r.ctx, time.Second)
		defer cancel()
		out, err := vm.ExecuteCommand(ctx, branch, workspaceapi.Command{Args: []string{"/bin/sh", "-c", script}})
		require.NoError(t, err)
		require.Zero(t, out.ExitCode, out.Stderr)
		return strings.TrimSpace(out.Stdout)
	}
	parent := command(`jj log -r '@-' --no-graph -T commit_id`)
	captured, err := registry.Capture(r.ctx, branch)
	require.NoError(t, err)
	// Keep real presence through the timeout and recovery: authorization from
	// this press, rather than the absence of people, must permit the retry.
	tab, err := r.openLive(r.jar)
	require.NoError(t, err)
	defer tab.stop()
	_, err = tab.subscribe("branch:" + branch)
	require.NoError(t, err)
	require.NoError(t, tab.presence(map[string]any{"branch": branch}))
	onto, err := r.pushMain("FREEZE-TIMEOUT-MAIN.md", "new main bytes\n", "Freeze timeout target")
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		require.NoError(t, tab.presence(map[string]any{"branch": branch}))
		card, err := r.j10Card(n)
		return err == nil && card.RebasePending != nil && card.RebasePending.Onto == "main"
	}, 2*time.Minute, time.Second)

	script := fmt.Sprintf(`import os,stat,sys
assert os.getuid()==%d and os.getgid()!=0 and 0 not in os.getgroups()
p='/var/lib/smithers/qualification/freeze-stall'
m=os.lstat(p)
assert stat.S_ISREG(m.st_mode) and m.st_uid==os.getuid() and stat.S_IMODE(m.st_mode)==0o600 and m.st_nlink==1
assert open('/sys/dev/block/%%d:%%d/dm/name'%%(os.major(m.st_dev),os.minor(m.st_dev))).read().strip()=='smithers-freeze-qualification'
print(os.getpid(),flush=True)
sys.stdin.buffer.readline()
f=os.open(p,os.O_WRONLY|os.O_NOFOLLOW)
os.write(f,b'composed kernel freeze qualification\n');os.fsync(f);os.close(f)
print('COMPLETED',flush=True)
`, user.UID)
	writer, err := sessions.OpenExec(r.ctx, user, []string{"/usr/bin/python3", "-I", "-S", "-c", script})
	require.NoError(t, err)
	t.Cleanup(func() { _ = writer.Close() })
	stderr := make(chan []byte, 1)
	go func() { raw, _ := io.ReadAll(writer.Stderr()); stderr <- raw }()
	reader := bufio.NewReader(writer.Stdout())
	line, err := reader.ReadString('\n')
	require.NoError(t, err)
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	require.NoError(t, err)
	require.Positive(t, pid)
	_, err = writer.Write([]byte("STALL\n"))
	require.NoError(t, err)
	require.NoError(t, writer.CloseWrite())
	require.Eventually(t, func() bool {
		return command(fmt.Sprintf(`awk '/^State:/{print $2}' /proc/%d/status`, pid)) == "D"
	}, 5*time.Second, 10*time.Millisecond)
	requestID := r.keyPrefix + "rebase-press"
	started := time.Now()
	code, data, err := r.keyed("POST", "/api/branches/"+url.PathEscape(before.Branch.Name), `{"rebase":true}`, requestID)
	require.NoError(t, err)
	require.Equal(t, 202, code, "%s", data)
	// Read the actual presser receipt; a 202 launch alone cannot qualify busy.
	var view struct {
		Pending *struct {
			Onto       string `json:"onto"`
			Revision   string `json:"onto_revision"`
			WaitingFor struct {
				Actor struct {
					Login string `json:"login"`
				} `json:"actor"`
				Terminal string `json:"terminal"`
			} `json:"waiting_for"`
		} `json:"rebase_pending"`
		Execution struct {
			State   string `json:"state"`
			Onto    string `json:"onto"`
			Session uint32 `json:"blocking_session"`
		} `json:"rebase_execution"`
	}
	read := func() {
		t.Helper()
		data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d?rebase_request=%s", n, url.QueryEscape(requestID)), "", 200)
		require.NoError(t, err)
		view.Pending = nil
		view.Execution.Session = 0
		require.NoError(t, json.Unmarshal(data, &view))
	}
	require.Eventually(t, func() bool {
		read()
		return view.Execution.Session == writer.ID()
	}, 10*time.Second, 100*time.Millisecond, "busy must name the actual D-state session")
	require.Equal(t, "running", view.Execution.State)
	require.Equal(t, onto, view.Execution.Onto)
	require.NotNil(t, view.Pending)
	require.Equal(t, "main", view.Pending.Onto)
	require.Equal(t, onto, view.Pending.Revision)
	require.Equal(t, owner.Username, view.Pending.WaitingFor.Actor.Login)
	require.NotEmpty(t, view.Pending.WaitingFor.Terminal)
	busyAt := time.Now()
	require.Equal(t, "0", command(`cat /sys/fs/cgroup/smithers/sessions/cgroup.freeze`), "timeout thaws the entire session subtree")
	require.Less(t, time.Since(busyAt), time.Second, "a new member session resumes within the thaw budget")
	require.Equal(t, parent, command(`jj log -r '@-' --no-graph -T commit_id`), "timeout cannot rewrite the parent")
	readCode, raw, err := r.request("GET", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path=JOURNEY.md", "")
	require.NoError(t, err)
	require.Equal(t, 200, readCode, "%s", raw)
	item, err := q.GetMythicalItemByNumber(r.ctx, row.RepositoryID, n)
	require.NoError(t, err)
	require.Equal(t, "rebase_pending", item.Reason)
	require.True(t, item.NextAttemptAt.Valid, "timeout must persist a retry deadline")
	var checks struct {
		Outages int `json:"outages"`
		Rebase  struct {
			Session uint32                  `json:"blocking_session"`
			Native  *machined.RewriteResult `json:"native"`
		} `json:"rebase"`
	}
	require.NoError(t, json.Unmarshal(item.Checks, &checks))
	require.Equal(t, writer.ID(), checks.Rebase.Session)
	require.Nil(t, checks.Rebase.Native, "busy cannot persist a completed rewrite")
	require.Zero(t, checks.Outages, "freeze contention cannot charge the outage allowance")
	// Snapshot IDs can advance on the ordinary cadence, but the captured tree
	// and target-file absence must remain unchanged until a successful rewrite.
	current, err := registry.Capture(r.ctx, branch)
	require.NoError(t, err)
	require.Equal(t, captured.Tree, current.Tree)
	missingCode, _, err := r.request("GET", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path=FREEZE-TIMEOUT-MAIN.md", "")
	require.NoError(t, err)
	require.Equal(t, 404, missingCode)
	require.Equal(t, "D", command(fmt.Sprintf(`awk '/^State:/{print $2}' /proc/%d/status`, pid)), "fixture must remain occupied through no-rewrite assertions")
	// A browser save after the timeout uses the ordinary authenticated file
	// door. It must survive the later retry rather than being overwritten by it.
	code, raw, err = r.request("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path=FREEZE-TIMEOUT-SAVE.md", `{"content":"saved while pending\n","base_digest":"absent"}`)
	require.NoError(t, err)
	require.Equal(t, 200, code, "%s", raw)
	previousDue := item.NextAttemptAt.Time
	require.Eventually(t, func() bool {
		pending, err := q.GetMythicalItemByNumber(r.ctx, row.RepositoryID, n)
		require.NoError(t, err)
		var retry struct {
			Outages int `json:"outages"`
			Rebase  struct {
				Session uint32                  `json:"blocking_session"`
				Native  *machined.RewriteResult `json:"native"`
			} `json:"rebase"`
		}
		require.NoError(t, json.Unmarshal(pending.Checks, &retry))
		require.Zero(t, retry.Outages, "retry cannot consume outage allowance")
		require.Nil(t, retry.Rebase.Native, "blocked retry cannot complete a rewrite")
		require.Equal(t, item.CandidateHead, pending.CandidateHead)
		return retry.Rebase.Session == writer.ID() && pending.Reason == "rebase_pending" && pending.NextAttemptAt.Valid && pending.NextAttemptAt.Time.After(previousDue)
	}, 10*time.Second, 100*time.Millisecond, "real scheduler must persist another busy receipt while the blocker remains")
	require.Equal(t, parent, command(`jj log -r '@-' --no-graph -T commit_id`), "repeated timeout cannot rewrite the parent")
	read()
	require.NotNil(t, view.Pending)
	require.Equal(t, writer.ID(), view.Execution.Session)

	// Observe the person's activity while the real blocker still holds. A
	// completed entry must not appear even transiently on a failed freeze.
	blockedActivity, err := r.expect("GET", "/api/branches/"+branch+"/activity", "", 200)
	require.NoError(t, err)
	var blockedEntries []map[string]any
	require.NoError(t, json.Unmarshal(blockedActivity, &blockedEntries))
	for _, entry := range blockedEntries {
		require.NotEqual(t, "rebase", entry["kind"], "busy cannot publish completed activity while the kernel blocker remains")
	}

	// No new POST, PollOnce, due-row edit or clock advance. The composed
	// worker must recover this same persisted request when the kernel releases D.
	completed, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "COMPLETED\n", completed)
	require.NoError(t, writer.Wait())
	require.Empty(t, <-stderr)
	require.Eventually(t, func() bool {
		require.NoError(t, tab.presence(map[string]any{"branch": branch}))
		read()
		return view.Execution.State == "completed"
	}, 2*time.Minute, 100*time.Millisecond, "original authorized request must retry automatically despite presence")
	require.Nil(t, view.Pending)
	require.Zero(t, view.Execution.Session)
	require.Equal(t, onto, command(`jj log -r '@-' --no-graph -T commit_id`))
	code, raw, err = r.request("GET", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path=FREEZE-TIMEOUT-MAIN.md", "")
	require.NoError(t, err)
	require.Equal(t, 200, code, "%s", raw)
	var file struct {
		Content string `json:"content"`
	}
	require.NoError(t, json.Unmarshal(raw, &file))
	require.Equal(t, "new main bytes\n", file.Content)
	code, raw, err = r.request("GET", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path=FREEZE-TIMEOUT-SAVE.md", "")
	require.NoError(t, err)
	require.Equal(t, 200, code, "%s", raw)
	require.NoError(t, json.Unmarshal(raw, &file))
	require.Equal(t, "saved while pending\n", file.Content)
	final, err := registry.Capture(r.ctx, branch)
	require.NoError(t, err)
	require.NoError(t, r.options.Repository.WithMachineRepository(r.ctx, "rehearsal-owner", "app", func(store string) error {
		for path, want := range map[string]string{"FREEZE-TIMEOUT-MAIN.md": "new main bytes\n", "FREEZE-TIMEOUT-SAVE.md": "saved while pending\n"} {
			raw, err := hostexec.Git(r.ctx, "-C", store, "show", final.Head+":"+path).Output()
			if err != nil {
				return err
			}
			require.Equal(t, want, string(raw), "host capture must retain %s", path)
		}
		return nil
	}))
	activityRaw, err := r.expect("GET", "/api/branches/"+branch+"/activity", "", 200)
	require.NoError(t, err)
	var activity []map[string]any
	require.NoError(t, json.Unmarshal(activityRaw, &activity))
	var rebases []map[string]any
	for _, entry := range activity {
		if entry["kind"] == "rebase" {
			rebases = append(rebases, entry)
		}
	}
	require.Len(t, rebases, 1, "busy attempts cannot publish completed activity")
	require.Equal(t, onto, rebases[0]["onto_revision"])
	require.Equal(t, true, rebases[0]["head_changed"])
	require.Equal(t, true, rebases[0]["approvals_cleared"])
	require.Equal(t, map[string]any{"kind": "system", "id": "stack", "color_index": float64(7)}, rebases[0]["actor"])
	receipt, err := json.MarshalIndent(map[string]any{"branch": branch, "session": writer.ID(), "pid": pid, "observed_state": "D", "before_parent": parent, "before_tree": captured.Tree, "busy_ns": busyAt.Sub(started).Nanoseconds(), "onto": onto, "execution": view.Execution, "automatic_retry": true, "activation": false}, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "composed-freeze-timeout.json"), receipt, 0600))
}
