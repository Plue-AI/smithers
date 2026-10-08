package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

// K4b retains the composed host, guest daemon and real broker-owned member
// process. Only the host's existing authoritative-head seam is held while the
// broken private connection retries; no simulated event or clock is involved.
func testMemberHostOutage(t *testing.T, r *rehearsal, vm *microsandbox.Runtime, branch string, run int,
	control func(string) ([]byte, error), evidence func(string, any), hostGit func(...string) []byte) {
	registry := vm.MachinedRegistry()
	prefix := fmt.Sprintf("host-session-K4b-%02d", run)
	before, err := registry.Capture(t.Context(), branch)
	require.NoError(t, err)
	session, err := r.openBranchTerminal(r.keyed, branch)
	require.NoError(t, err)
	terminal, err := r.openTerminal(session)
	require.NoError(t, err)
	defer terminal.close()
	gate := "/tmp/" + prefix + "-go"
	logPath := "/tmp/" + prefix + "-writer.jsonl"
	script := fmt.Sprintf(`import os,time,hashlib,json
with open(%q+'.process','x') as f: f.write(json.dumps({'pid':os.getpid(),'uid':os.getuid(),'cgroup':open('/proc/self/cgroup').read()}))
with open(%q,'x') as log:
 for i in range(50):
  while not os.path.exists(%q+str(i)): time.sleep(.01)
  p=%q+'-%%02d.txt'%%i
  b=('acknowledged '+p+'\n').encode()
  f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
  assert os.write(f,b)==len(b)
  os.fsync(f)
  os.close(f)
  line=json.dumps({'seq':i,'path':p,'sha256':hashlib.sha256(b).hexdigest()})
  log.write(line+'\n'); log.flush(); os.fsync(log.fileno())
  print(line,flush=True)
`, logPath, logPath, gate, prefix)
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	done := make(chan error, 1)
	go func() {
		status, output, err := terminal.capture("python3 -I -S -c "+quote(script), "K4BDONE", 240*time.Second)
		if err == nil && status != "0" {
			err = fmt.Errorf("member writer: status %s: %s", status, output)
		}
		done <- err
	}()
	// Observe the member process before cutting the transport. The log is
	// outside /workspace, so diagnostic bytes cannot manufacture activity.
	require.Eventually(t, func() bool {
		out, err := control(fmt.Sprintf("import os\nprint(os.path.exists(%q))", logPath))
		return err == nil && strings.TrimSpace(string(out)) == "True"
	}, 10*time.Second, 25*time.Millisecond)
	process, err := control(fmt.Sprintf("print(open(%q+'.process').read(),end='')", logPath))
	require.NoError(t, err)
	var member struct {
		PID, UID int
		Cgroup   string
	}
	require.NoError(t, json.Unmarshal(process, &member))
	require.GreaterOrEqual(t, member.UID, 20000)
	require.Contains(t, member.Cgroup, "/smithers/sessions/", "writer must run in the production broker member cgroup")
	evidence(prefix+"-member-process.json", member)
	reconnect := make(chan struct{})
	var resume sync.Once
	release := func() { resume.Do(func() { close(reconnect) }) }
	defer release()
	head := machineBranchHead(r.pool, r.options.Repository)
	vm.BindMachinedHost(func(ctx context.Context, id string) (string, error) {
		if id == branch {
			select {
			case <-reconnect:
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		return head(ctx, id)
	})
	defer vm.BindMachinedHost(head)
	link, err := registry.Current(branch)
	require.NoError(t, err)
	cut := time.Now()
	require.NoError(t, link.Close())
	for n := 0; n < 50; n++ {
		out, err := control(fmt.Sprintf("import os\nf=os.open(%q,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o644)\nos.close(f)", gate+fmt.Sprint(n)))
		require.NoError(t, err, "%s", out)
		require.Eventually(t, func() bool {
			out, err := control(fmt.Sprintf("from pathlib import Path\np=Path(%q)\nprint(len(p.read_text().splitlines()) if p.exists() else 0)", logPath))
			return err == nil && strings.TrimSpace(string(out)) == fmt.Sprint(n+1)
		}, 10*time.Second, 25*time.Millisecond, "member write must finish fsync and close before capture")
		out, err = control("import os\np='/var/lib/smithers-machined/qualification-K4b-capture.arm'\nf=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)\nos.fsync(f)\nos.close(f)")
		require.NoError(t, err, "%s", out)
		require.Eventually(t, func() bool {
			out, err := control("from pathlib import Path\np=Path('/var/lib/smithers-machined/qualification-K4b-capture.hit')\nprint(p.read_text() if p.exists() else '')")
			return err == nil && strings.TrimSpace(string(out)) == "captured"
		}, 30*time.Second, 25*time.Millisecond, "ordinary local capture must close each real member burst offline")
		out, err = control("import os\nos.unlink('/var/lib/smithers-machined/qualification-K4b-capture.hit')")
		require.NoError(t, err, "%s", out)
	}
	var count int
	require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT count(*) FROM burst_files WHERE path LIKE $1`, prefix+"-%").Scan(&count))
	require.Zero(t, count, "disconnected host cannot commit the member bursts")
	queued, err := control("import os,json,base64\np='/var/lib/smithers-machined/outbox'\nprint(json.dumps({n:base64.b64encode(open(p+'/'+n,'rb').read()).decode() for n in os.listdir(p) if n.endswith('.ev')}))")
	require.NoError(t, err)
	var outbox map[string]string
	require.NoError(t, json.Unmarshal(queued, &outbox))
	require.GreaterOrEqual(t, len(outbox), 100)
	evidence(prefix+"-outbox-at-cut.json", outbox)
	// Preserve the normative minimum even if the fifty captures finish sooner.
	timer := time.NewTimer(max(time.Duration(0), 30*time.Second-time.Since(cut)))
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-t.Context().Done():
		t.Fatal(t.Context().Err())
	}
	outageDuration := time.Since(cut)
	release()
	require.Eventually(t, func() bool {
		next, err := registry.Current(branch)
		return err == nil && next != link && next.RequireReady(branch) == nil
	}, 45*time.Second, 25*time.Millisecond, "production host reconnect must recover without a restart")
	after, err := registry.Capture(t.Context(), branch)
	require.NoError(t, err)
	// A broken host stream can close its browser socket. Reattach the same
	// admitted session through the production terminal route after replay.
	terminal.close()
	resumed, err := r.openTerminal(session)
	require.NoError(t, err)
	status, output, err := resumed.capture("id -u", "K4BREADY", 15*time.Second)
	resumed.close()
	require.NoError(t, err)
	require.Equal(t, "0", status)
	require.Equal(t, fmt.Sprint(member.UID), strings.TrimSpace(string(output)))
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("old terminal consumer did not finish")
	}
	writer, err := control(fmt.Sprintf("print(open(%q).read(),end='')", logPath))
	require.NoError(t, err)
	var writes []map[string]any
	for n, line := range strings.Split(strings.TrimSpace(string(writer)), "\n") {
		var written map[string]any
		require.NoError(t, json.Unmarshal([]byte(line), &written))
		path := fmt.Sprintf("%s-%02d.txt", prefix, n)
		bytes := []byte("acknowledged " + path + "\n")
		digest := sha256.Sum256(bytes)
		require.Equal(t, float64(n), written["seq"])
		require.Equal(t, path, written["path"])
		require.Equal(t, hex.EncodeToString(digest[:]), written["sha256"])
		require.Equal(t, bytes, hostGit("show", after.Head+":"+path))
		code, body, err := r.request("GET", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path="+url.QueryEscape(path), "")
		require.NoError(t, err)
		require.Equal(t, 200, code, "%s", body)
		var file struct{ Content, Digest string }
		require.NoError(t, json.Unmarshal(body, &file))
		require.Equal(t, string(bytes), file.Content)
		require.Equal(t, hex.EncodeToString(digest[:]), file.Digest)
		var rows int
		var post, versions, burst, blob string
		require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT count(*),min(post_digest) FROM burst_files WHERE path=$1`, path).Scan(&rows, &post))
		require.Equal(t, 1, rows)
		require.Equal(t, file.Digest, post)
		require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT e.data->>'versions',e.data->>'id',f.after_blob FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE f.path=$1`, path).Scan(&versions, &burst, &blob))
		require.Equal(t, bytes, hostGit("show", versions+":b/"+path))
		require.Equal(t, bytes, hostGit("cat-file", "blob", blob))
		require.Equal(t, versions, strings.TrimSpace(string(hostGit("rev-parse", "refs/smithers/branches/"+branch+"/bursts/"+burst))))
		writes = append(writes, written)
	}
	require.Len(t, writes, 50)
	require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT count(DISTINCT event_id) FROM burst_files WHERE path LIKE $1`, prefix+"-%").Scan(&count))
	require.Equal(t, 50, count)
	drained, err := control("import os,json\nprint(json.dumps([n for n in os.listdir('/var/lib/smithers-machined/outbox') if n.endswith('.ev')]))")
	require.NoError(t, err)
	var remaining []string
	require.NoError(t, json.Unmarshal(drained, &remaining))
	require.Empty(t, remaining)
	for _, table := range []string{"machine_event_receipts", "product_job_events", "burst_files"} {
		var rows []byte
		require.NoError(t, r.pool.QueryRow(t.Context(), "SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]') FROM "+table+" r").Scan(&rows))
		evidence(prefix+"-"+table+".json", json.RawMessage(rows))
	}
	evidence(prefix+"-outbox-after.json", remaining)
	evidence(prefix+"-writer.json", writes)
	evidence(prefix+"-heads.json", map[string]any{"before": before, "after": after})
	evidence(prefix+"-outage.json", map[string]any{"outage_ms": outageDuration.Milliseconds(), "host_restarts": 0, "host_pid": os.Getpid(), "member_session": session})
}
