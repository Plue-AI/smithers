package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

// The W1-W4 preservation campaign enters the composed browser file door and
// authenticated broker sessions on a production-created microVM. It covers the
// fifty rewrites and ten Return cycles. Frozen/timeout/swap barriers and the ACK
// delay/timing campaign are separate requirements; this test does not claim them.
// The bundle is install-controlled; no checkout program executes as root.
func TestMachinedMutationWriterPreservation(t *testing.T) {
	if os.Getenv("SMITHERS_MACHINED_WRITER_REFERENCE") != "1" {
		t.Skip("reference Mac and approved installed bundle required for W1-W4")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	_, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
	require.NoError(t, err)
	t.Setenv(pinnedMicroVMRehearsal, "1")
	r := newRehearsal(t, pinnedMicroVMRehearsal, "C-COL-03", "writers-")
	vm, ok := r.workspaceRuntime.(*microsandbox.Runtime)
	require.True(t, ok)
	require.True(t, r.install("Install through Machine ready"))
	number, err := r.file("Concurrent writer canary", "Add a greeting to JOURNEY.md")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(number, 15*time.Minute, "in_review")
	require.NoError(t, err)
	branch, _, err := r.todoHostBinding(number)
	require.NoError(t, err)
	registry := vm.MachinedRegistry()
	link, err := registry.Current(branch)
	require.NoError(t, err)
	row, err := db.New(r.pool).GetWorkspace(t.Context(), branch)
	require.NoError(t, err)
	member, err := db.New(r.pool).GetSelfHostOwner(t.Context())
	require.NoError(t, err)
	var user machined.SessionUser
	require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT unix_login,unix_uid FROM collaborators WHERE repository_id=$1 AND user_id=$2`, row.RepositoryID, member.ID).Scan(&user.Login, &user.UID))
	person, err := machined.CommitActor(t.Context(), r.pool, branch, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: member.ID, Via: "terminal"}, nil
	})
	require.NoError(t, err)
	run := uuid.NewString()
	agent, err := machined.CommitActor(t.Context(), r.pool, branch, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "agent", MemberID: member.ID, Via: "agent", AgentKind: "coding", Run: run}, nil
	})
	require.NoError(t, err)
	sessions := machined.NewSessions(link.Connection, branch, registry.Sessions(branch)).WithActor(person, "")
	coding := sessions.WithActor(agent, run)
	type logged struct{ Writer, Path, SHA256 string }
	var mu sync.Mutex
	var writes []logged
	var failures []error
	appendWrite := func(w logged) { mu.Lock(); writes = append(writes, w); mu.Unlock() }
	fail := func(err error) { mu.Lock(); failures = append(failures, err); mu.Unlock() }
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Minute)
	defer cancel()
	// One stream per writer, kept alive across all rebase cycles. Agent input is
	// held until register_run commits its production broker admission.
	script := func(writer string) string {
		return fmt.Sprintf(`import os,sys,time,json,hashlib,subprocess
sys.stdin.buffer.readline()
for i in range(1200):
 p='col03-%%s-%%04d.txt'%%(%q,i)
 b=('acknowledged '+p+'\n').encode()
 if %q=='W2':
  c=subprocess.run(['/opt/smithers/bin/smithers-machined','client','write-file',p,'--base','absent'],input=b,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  if c.returncode:
   raise RuntimeError(c.stdout.decode()+c.stderr.decode())
 else:
  temp=p+'.swap' if %q=='W4' else p
  f=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o664)
  assert os.write(f,b)==len(b)
  os.fsync(f)
  os.close(f)
  if temp!=p:
   os.replace(temp,p)
   d=os.open('.',os.O_RDONLY|os.O_DIRECTORY);os.fsync(d);os.close(d)
 print(json.dumps({'Writer':%q,'Path':p,'SHA256':hashlib.sha256(b).hexdigest()}),flush=True)
 time.sleep(.1)
`, writer, writer, writer, writer)
	}
	var executions []*machined.Exec
	var readers sync.WaitGroup
	startWriter := func(writer string, s *machined.Sessions, identity machined.SessionUser) {
		t.Helper()
		e, err := s.OpenExec(ctx, identity, []string{"/usr/bin/python3", "-I", "-S", "-c", script(writer)})
		require.NoError(t, err)
		executions = append(executions, e)
		t.Cleanup(func() {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			_ = e.Kill(cleanup)
		})
		readers.Add(2)
		go func() {
			defer readers.Done()
			scanner := bufio.NewScanner(e.Stdout())
			for scanner.Scan() {
				var w logged
				if err := json.Unmarshal(scanner.Bytes(), &w); err != nil {
					fail(err)
					continue
				}
				expected := sha256.Sum256([]byte("acknowledged " + w.Path + "\n"))
				if w.Writer != writer || w.SHA256 != hex.EncodeToString(expected[:]) {
					fail(fmt.Errorf("invalid %s writer log: %s", writer, scanner.Text()))
					continue
				}
				appendWrite(w)
			}
			if err := scanner.Err(); err != nil {
				fail(err)
			}
		}()
		go func() {
			defer readers.Done()
			b, err := io.ReadAll(e.Stderr())
			if err != nil {
				fail(err)
			}
			if len(b) > 0 {
				fail(fmt.Errorf("%s stderr: %s", writer, b))
			}
		}()
		if writer == "W2" {
			require.NoError(t, coding.RegisterRun(ctx, run, e.ID()))
		}
		_, err = e.Write([]byte("start\n"))
		require.NoError(t, err)
	}
	startWriter("W2", coding, machined.SessionUser{Login: "agent", UID: 19999})
	// SessionExec is the same broker cgroup used by a member terminal/SSH
	// process. W3 uses direct writes and W4 the editor's atomic replacement.
	startWriter("W3", sessions, user)
	startWriter("W4", sessions.WithPresenceVia("ssh"), user)
	var httpWriters sync.WaitGroup
	httpWriters.Add(1)
	go func() {
		defer httpWriters.Done()
		for i := 0; i < 1200; i++ {
			p := fmt.Sprintf("col03-W1-%04d.txt", i)
			content := "acknowledged " + p + "\n"
			body, _ := json.Marshal(map[string]string{"content": content, "base_digest": "absent"})
			code, data, err := r.keyed("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path="+url.QueryEscape(p), string(body), uuid.NewString())
			if err != nil || code != 200 {
				fail(fmt.Errorf("W1 HTTP %d: %v %s", code, err, data))
				return
			}
			sum := sha256.Sum256([]byte(content))
			appendWrite(logged{"W1", p, hex.EncodeToString(sum[:])})
			select {
			case <-ctx.Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
	}()
	// Ensure every writer has acknowledged data before the first rewrite.
	require.Eventually(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		seen := map[string]bool{}
		for _, w := range writes {
			seen[w.Writer] = true
		}
		return len(seen) == 4
	}, 30*time.Second, 10*time.Millisecond)
	var rewriteTimes []int64
	for i := 0; i < 50; i++ {
		began := time.Now()
		_, err := registry.Rebase(ctx, branch, person, r.mainCommit)
		require.NoError(t, err, "rebase %d", i)
		rewriteTimes = append(rewriteTimes, time.Since(began).Nanoseconds())
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(2 * time.Second):
		}
	}
	httpWriters.Wait()
	for _, e := range executions {
		require.NoError(t, e.CloseWrite())
		require.NoError(t, e.Wait())
		require.NoError(t, e.Close())
	}
	readers.Wait()
	mu.Lock()
	acknowledged := append([]logged(nil), writes...)
	errs := append([]error(nil), failures...)
	mu.Unlock()
	require.Empty(t, errs)
	counts := map[string]int{}
	for _, w := range acknowledged {
		counts[w.Writer]++
	}
	for _, writer := range []string{"W1", "W2", "W3", "W4"} {
		require.Equal(t, 1200, counts[writer], writer)
	}
	// Return is driven through the host registry after a real member jj move.
	terminalID, err := r.openBranchTerminal(r.keyed, branch)
	require.NoError(t, err)
	terminal, err := r.openTerminal(terminalID)
	require.NoError(t, err)
	defer terminal.close()
	for i := 0; i < 10; i++ {
		status, out, err := terminal.capture("jj new main", "COL03MOVE", 30*time.Second)
		require.NoError(t, err)
		require.Equal(t, "0", status, "%s", out)
		_, err = registry.ReturnToItem(ctx, branch, person)
		require.NoError(t, err, "Return %d", i)
	}
	captured, err := registry.Capture(ctx, branch)
	require.NoError(t, err)
	// Every acknowledged version is independently hashed from real host objects.
	// A Return can remove files from the working tree, but not their versions.
	require.NoError(t, r.options.Repository.WithMachineRepository(ctx, "rehearsal-owner", "app", func(store string) error {
		for _, w := range acknowledged {
			out, err := hostexec.Git(ctx, "-C", store, "show", captured.Head+":"+w.Path).Output()
			if err == nil {
				sum := sha256.Sum256(out)
				if hex.EncodeToString(sum[:]) == w.SHA256 {
					continue
				}
			}
			rows, err := r.pool.Query(ctx, `SELECT after_blob FROM burst_files WHERE path=$1 AND post_digest=$2`, w.Path, w.SHA256)
			if err != nil {
				return err
			}
			found := false
			for rows.Next() {
				var blob string
				if err = rows.Scan(&blob); err != nil {
					rows.Close()
					return err
				}
				out, err = hostexec.Git(ctx, "-C", store, "cat-file", "blob", blob).Output()
				if err == nil {
					sum := sha256.Sum256(out)
					found = found || hex.EncodeToString(sum[:]) == w.SHA256
				}
			}
			rows.Close()
			if err = rows.Err(); err != nil {
				return err
			}
			if !found {
				return fmt.Errorf("lost acknowledged %s %s %s", w.Writer, w.Path, w.SHA256)
			}
		}
		return nil
	}))
	for name, value := range map[string]any{"writers.json": acknowledged, "rewrite-rpc-nanoseconds.json": rewriteTimes, "captured.json": captured} {
		bytes, err := json.MarshalIndent(value, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, name), append(bytes, '\n'), 0600))
	}
	// These are end-to-end RPC durations, deliberately not freeze p95 receipts.
	t.Logf("50 native rebases, 10 Return cycles, %d independently verified writes", len(acknowledged))
}
