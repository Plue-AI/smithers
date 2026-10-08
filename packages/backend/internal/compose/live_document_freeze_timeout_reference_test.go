package compose

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// C-COL-03: the owner provisions the dedicated >=5 s dm-delay fixture in the
// approved image. This driver never mounts a device, writes a cgroup path or
// starts privileged checkout code. A sleepy process cannot substitute for D.
func TestLiveDocumentOccupiedFreezeTimeout(t *testing.T) {
	if os.Getenv("SMITHERS_LIVE_DOCUMENT_FREEZE_TIMEOUT_REFERENCE") != "1" {
		t.Skip("approved reference guest with owner-provisioned dm-delay freeze-stall file required")
	}
	t.Setenv("SMITHERS_LIVE_DOCUMENT_SECURITY_REFERENCE", "1")
	f := liveDocumentReferenceMachine(t)
	f.command(t, `printf 'FREEZE DOCUMENT 🧑🏽‍💻 é 漢字\n' > retry.ts`)
	doc := openLiveWriterProbe(t, f.registry, f.branch, "retry.ts", f.actor)
	const text = "FREEZE DOCUMENT 🧑🏽‍💻 e\u0301 漢字\n"
	doc.converge(t, text)
	captured, err := f.registry.Capture(t.Context(), f.branch)
	require.NoError(t, err)
	onto := strings.TrimSpace(f.command(t, fmt.Sprintf(`tree=$(git rev-parse '%s^{tree}') && printf 'Freeze timeout independent target\n' | git -c user.name=Qualification -c user.email=qualification@example.invalid commit-tree "$tree"`, captured.Head)))
	require.Len(t, onto, 40)
	parent := f.command(t, `jj log -r '@-' --no-graph -T commit_id`)
	link, err := f.registry.Current(f.branch)
	require.NoError(t, err)
	sessions := machined.NewSessions(link.Connection, f.branch, f.registry.Sessions(f.branch)).WithActor(f.actor, "").WithPresenceVia("terminal")
	// Both payload and observer execute as the admitted member. Validate the
	// protected, fixed device/file identity before touching the stall fixture.
	script := fmt.Sprintf(`import os,stat,sys
assert os.getuid()==%d and os.getgid()!=0 and 0 not in os.getgroups()
p='/var/lib/smithers/qualification/freeze-stall'
m=os.lstat(p)
assert stat.S_ISREG(m.st_mode) and m.st_uid==os.getuid() and stat.S_IMODE(m.st_mode)==0o600 and m.st_nlink==1
name=open('/sys/dev/block/%%d:%%d/dm/name'%%(os.major(m.st_dev),os.minor(m.st_dev))).read().strip()
assert name=='smithers-freeze-qualification'
print(os.getpid(),flush=True)
sys.stdin.buffer.readline()
f=os.open(p,os.O_WRONLY|os.O_NOFOLLOW)
os.write(f,b'live document kernel freeze qualification\n')
os.fsync(f);os.close(f)
print('COMPLETED',flush=True)
`, f.ben.UID)
	writer, err := sessions.OpenExec(t.Context(), f.ben, []string{"/usr/bin/python3", "-I", "-S", "-c", script})
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
	// An observer in another real session of the same member sees the actual
	// kernel task state. Its own session ends before the freeze request.
	observe := func(program string) string {
		t.Helper()
		process, err := sessions.OpenExec(t.Context(), f.ben, []string{"/usr/bin/python3", "-I", "-S", "-c", program})
		require.NoError(t, err)
		raw, err := io.ReadAll(process.Stdout())
		require.NoError(t, err)
		require.NoError(t, process.Wait())
		errors, err := io.ReadAll(process.Stderr())
		require.NoError(t, err)
		require.Empty(t, errors)
		require.NoError(t, process.Close())
		return strings.TrimSpace(string(raw))
	}
	require.Eventually(t, func() bool {
		return observe(fmt.Sprintf(`print(next(line.split()[1] for line in open('/proc/%d/status') if line.startswith('State:')))`, pid)) == "D"
	}, 5*time.Second, 10*time.Millisecond)
	// Retain typing during the occupied freeze attempt. Do not await saved
	// before the rewrite: the FIFO must preserve it when freeze returns busy.
	const pending = "PENDING-TIMEOUT 🧑🏽‍💻 e\u0301 "
	update := codeInsert(doc.client, pending)
	_, err = doc.replica.Peer(update)
	require.NoError(t, err)
	want, err := doc.replica.Text("content")
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(want, pending))
	require.Equal(t, text, strings.Replace(want, pending, "", 1))
	doc.send(t, codeSync(2, update))
	began := time.Now()
	_, err = f.registry.Rebase(t.Context(), f.branch, f.actor, onto)
	elapsed := time.Since(began)
	var refusal *machined.SessionError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "busy", refusal.Code)
	require.Equal(t, writer.ID(), refusal.Session, "broker names the real stalled writer")
	require.Less(t, elapsed, 2*time.Second, "one-second freeze budget plus host transport")
	require.Equal(t, parent, f.command(t, `jj log -r '@-' --no-graph -T commit_id`), "timeout cannot rewrite the item parent")
	saveCtx, cancelSave := context.WithTimeout(t.Context(), time.Second)
	defer cancelSave()
	for {
		frame := doc.receive(t, saveCtx)
		if frame.Msg == wire.DocumentSaved && frame.ThroughSeq >= doc.seq {
			break
		}
	}
	require.Equal(t, want, f.command(t, `cat retry.ts`))
	require.Equal(t, "0", observe(`print(open('/sys/fs/cgroup/smithers/sessions/cgroup.freeze').read().strip())`), "timeout must thaw the fixed parent")
	completed, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "COMPLETED\n", completed)
	require.NoError(t, writer.Wait())
	require.Empty(t, <-stderr)
	require.NoError(t, writer.Close())
	// Once the real kernel write finishes, the same dispatch must succeed and
	// the existing live replica and saved bytes must remain identical.
	_, err = f.registry.Rebase(t.Context(), f.branch, f.actor, onto)
	require.NoError(t, err)
	doc.converge(t, want)
	require.Equal(t, want, f.command(t, `cat retry.ts`))
	require.NoError(t, doc.stream.Close())
	reopened := openLiveWriterProbe(t, f.registry, f.branch, "retry.ts", f.actor)
	require.Equal(t, doc.epoch, reopened.epoch)
	reopened.converge(t, want)
	evidence, err := json.Marshal(map[string]any{"session": writer.ID(), "pid": pid, "observed_state": "D", "refusal": refusal, "elapsed_ns": elapsed.Nanoseconds(), "before_parent": parent, "onto": onto, "text": want, "activation": false})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(f.r.evidence, "live-document-freeze-timeout.json"), evidence, 0600))
}
