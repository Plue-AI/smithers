package compose

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

// Sleep/wake uses the served owner action and the same installed gateway. It
// never substitutes a process runtime or injects an admission completion.
func exerciseSSHRetainedRootInputs(t *testing.T, h *rootLayerHarness, client *gossh.Client, address, login string, signer gossh.Signer, member int64, uid uint32) {
	t.Helper()
	var branch string
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT id FROM workspaces WHERE status='running' AND (target_bookmark=$1 OR target_bookmark='smithers/' || $1)`, login).Scan(&branch))
	run := func(c *gossh.Client, text string) []byte {
		t.Helper()
		s, err := c.NewSession()
		require.NoError(t, err)
		defer s.Close()
		output, err := s.CombinedOutput(text)
		require.NoError(t, err, string(output))
		return output
	}
	require.Equal(t, uint32(20000), uid)
	// Branch-owned startup candidates and escaping cwd survive on the
	// retained disk. Root must never resolve either as its executable/cwd.
	run(client, `mkdir -p /workspace/trm03-retained; printf '#!/bin/sh\nprintf root-canary > /etc/trm03-root-canary\n' > /workspace/trm03-retained/sh; chmod 755 /workspace/trm03-retained/sh; ln -s /etc /workspace/trm03-retained/cwd; printf retained > /workspace/trm03-retained/marker`)
	live, err := client.NewSession()
	require.NoError(t, err)
	defer live.Close()
	require.NoError(t, live.Start("exec sleep 120"))
	closed := make(chan error, 1)
	go func() { closed <- live.Wait() }()
	code, body := h.request("POST", "/api/branches/"+branch, `{"op":"sleep"}`, uuid.NewString())
	require.Equal(t, 202, code, string(body))
	require.Eventually(t, func() bool {
		machine, err := h.runtime.InspectWorkspace(t.Context(), branch)
		return err == nil && machine.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	select {
	case err := <-closed:
		require.Error(t, err, "sleep must terminate the old live guest session")
	case <-time.After(5 * time.Second):
		t.Fatal("sleep retained the old SSH process/channel")
	}
	retained, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	require.NoError(t, err)
	defer retained.Close()
	s, err := retained.NewSession()
	require.NoError(t, err)
	defer s.Close()
	for _, env := range [][2]string{{"PATH", "/workspace/trm03-retained"}, {"SHELL", "/workspace/trm03-retained/sh"}, {"HOME", "/workspace/trm03-retained/cwd"}, {"PWD", "/workspace/trm03-retained/cwd"}, {"LD_PRELOAD", "/workspace/trm03-retained/loader.so"}} {
		require.NoError(t, s.Setenv(env[0], env[1]))
	}
	output, err := s.CombinedOutput(`id -u; id -g; awk '/^Groups:/ {if (NF == 2) print $2}' /proc/$$/status; pwd; cat /workspace/trm03-retained/marker; test ! -e /etc/trm03-root-canary; test ! -e /workspace/trm03-root-canary; test ! -w /etc; cat /proc/self/cgroup`)
	require.NoError(t, err, string(output))
	require.Regexp(t, `^20000\n20000\n20000\n/workspace\nretained0::/smithers/sessions/s[1-9][0-9]*\n$`, string(output))
	// Repeat the authenticated envelopes and roster fence against this
	// retained boot, then exercise filesystem races with SSH positive controls.
	exerciseSSHBrokerSemanticInputs(t, h, retained, login, member, uid)
	exerciseSSHRetainedFilesystemRace(t, retained)
	exerciseSSHRetainedExecutableRace(t, retained)
	exerciseSSHRetainedCwdRace(t, retained)
	require.Equal(t, "20000\n/workspace\n", string(run(retained, "id -u; pwd")))
	run(retained, "rm -rf /workspace/trm03-retained")
	exerciseSSHQueuedWakeRevocation(t, h, branch, address, login, signer)
	t.Logf("C-J3-06 retained SSH wake: member=%d; raw private socket acceptance still requires approved guest test bundle", member)
}

// A second real branch holds the single owner-configured slot. The revoked
// SSH request must never start when that slot is freed. Both the setting and
// revocation enter the served install router; no test-only admission gate.
func exerciseSSHQueuedWakeRevocation(t *testing.T, h *rootLayerHarness, branch, address, login string, survivor gossh.Signer) {
	t.Helper()
	q := db.New(h.pool)
	saved, err := q.GetInstallCapacity(t.Context())
	require.NoError(t, err)
	restore := func() {
		if len(saved.Capacity) > 0 && string(saved.Capacity) != "null" {
			h.expect("PUT", "/api/install", `{"capacity":`+string(saved.Capacity)+`}`, 200)
		} else {
			_, err := h.pool.Exec(t.Context(), `DELETE FROM install_settings WHERE key='capacity'`)
			require.NoError(t, err)
		}
	}
	defer restore()
	body := h.expect("POST", "/api/todos", `{"title":"SSH queue holder","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, 202)
	var todo struct {
		N int64 `json:"n"`
	}
	require.NoError(t, json.Unmarshal(body, &todo))
	var holder string
	require.Eventually(t, func() bool {
		if err := h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=$1`, todo.N).Scan(&holder); err != nil || holder == "" || holder == branch {
			return false
		}
		machine, err := h.runtime.InspectWorkspace(t.Context(), holder)
		return err == nil && machine.State == workspaceapi.WorkspaceRunning
	}, 15*time.Minute, 250*time.Millisecond)
	observer := installedMemberTerminal(t, h, holder, h.jar)
	defer observer.close()
	h.expect("PUT", "/api/install", `{"capacity":1}`, 200)
	body = h.expect("POST", "/api/branches/"+branch, `{"op":"sleep"}`, 202)
	require.Eventually(t, func() bool {
		machine, err := h.runtime.InspectWorkspace(t.Context(), branch)
		return err == nil && machine.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	revoked, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	create, err := json.Marshal(map[string]string{"title": "SSH queued wake proof", "key": string(gossh.MarshalAuthorizedKey(revoked.PublicKey()))})
	require.NoError(t, err)
	var key struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(h.expect("POST", "/api/user/keys", string(create), 201), &key))
	queued, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(revoked)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	require.NoError(t, err)
	defer queued.Close()
	session, err := queued.NewSession()
	require.NoError(t, err)
	defer session.Close()
	stderr, err := session.StderrPipe()
	require.NoError(t, err)
	position := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "waiting for a machine") {
				position <- scanner.Text()
				return
			}
		}
		position <- ""
	}()
	finished := make(chan error, 1)
	go func() { finished <- session.Run("touch /workspace/trm03-revoked-wake-canary") }()
	select {
	case line := <-position:
		require.Contains(t, line, "waiting for a machine #1")
	case <-time.After(30 * time.Second):
		t.Fatal("SSH never reached the real capacity queue")
	}
	machine, err := h.runtime.InspectWorkspace(t.Context(), branch)
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceStopped, machine.State)
	h.expect("DELETE", fmt.Sprintf("/api/user/keys/%d", key.ID), "", 204)
	select {
	case err := <-finished:
		require.Error(t, err, "withdrawn queued key must never execute")
	case <-time.After(5 * time.Second):
		t.Fatal("key withdrawal retained the queued SSH connection")
	}
	h.expect("POST", "/api/branches/"+holder, `{"op":"sleep"}`, 202)
	require.Eventually(t, func() bool {
		machine, err := h.runtime.InspectWorkspace(t.Context(), holder)
		return err == nil && machine.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	restore()
	valid, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(survivor)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	require.NoError(t, err)
	defer valid.Close()
	positive, err := valid.NewSession()
	require.NoError(t, err)
	defer positive.Close()
	output, err := positive.CombinedOutput("id -u; pwd; test ! -e /workspace/trm03-revoked-wake-canary; test ! -e /etc/trm03-root-canary")
	require.NoError(t, err, string(output))
	require.Equal(t, "20000\n/workspace\n", string(output))
	refused, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(revoked)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
	if refused != nil {
		refused.Close()
	}
	require.Error(t, err)
}
