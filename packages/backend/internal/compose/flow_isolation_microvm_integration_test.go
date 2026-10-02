package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// This canary qualifies discovery and graph planning in a real guest. It does
// not claim the install's TODO lifecycle or flow.run API acceptance, which
// require their separately provisioned machine and TODO compositions.
func TestRepositoryFlowImportsStayInsideRealMicroVM(t *testing.T) {
	if os.Getenv("SMITHERS_FLOW_ISOLATION_CHECK") != "1" {
		t.Skip("set SMITHERS_FLOW_ISOLATION_CHECK=1 for the real microVM canary")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	msb, err := exec.LookPath("msb")
	require.NoError(t, err)
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	evidence := os.Getenv("SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR")
	writeEvidence := func(name string, data []byte) {
		t.Helper()
		if evidence == "" {
			return
		}
		require.NoError(t, os.MkdirAll(evidence, 0700))
		require.NoError(t, os.WriteFile(filepath.Join(evidence, name), data, 0600))
	}
	run := func(binary string, args ...string) []byte {
		t.Helper()
		command := exec.CommandContext(ctx, binary, args...)
		command.Dir = root
		output, err := command.CombinedOutput()
		require.NoError(t, err, "%s %v: %s", filepath.Base(binary), args, output)
		return output
	}
	writeEvidence("msb-version.txt", run(msb, "--version"))
	work := t.TempDir()
	bundle := filepath.Join(work, "canary.mjs")
	fixture := filepath.Join(root, "flows/test/fixtures/flow-isolation-canary.ts")
	fixtureBefore, err := os.ReadFile(fixture)
	require.NoError(t, err)
	require.Less(t, len(fixtureBefore), 64*1024, "canary entry must be source, never a compiled bundle")
	// argv supplies paths without shell interpolation or importing any fixture
	// repository flow into the host bundler process.
	run(node, "--input-type=module", "-e", `import { pathToFileURL } from "node:url";
const [bundler, entry, output] = process.argv.slice(1);
process.argv[1] = "flow-isolation-build-driver";
const { bundle } = await import(pathToFileURL(bundler).href);
await bundle(entry, output);`,
		filepath.Join(root, "flows/coding/build.mjs"), fixture, bundle)
	fixtureAfter, err := os.ReadFile(fixture)
	require.NoError(t, err)
	require.Equal(t, fixtureBefore, fixtureAfter, "bundling must never mutate the entry source")
	nonce := strings.ReplaceAll(uuid.NewString(), "-", "")
	markerName := ".smithers-canary-" + nonce
	home, err := os.UserHomeDir()
	require.NoError(t, err)
	hostMarker := filepath.Join(home, markerName)
	_, err = os.Stat(hostMarker)
	require.True(t, os.IsNotExist(err), "host marker must start absent: %v", err)
	t.Cleanup(func() { _ = os.Remove(hostMarker) })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	var connections atomic.Int64
	listenerDone := make(chan struct{})
	go func() {
		defer close(listenerDone)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			connections.Add(1)
			_ = connection.Close()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); <-listenerDone })
	port := listener.Addr().(*net.TCPAddr).Port
	repository := filepath.Join(work, "repository")
	for _, name := range []string{"todo", "canary", "merge"} {
		directory := filepath.Join(repository, "flows", name)
		require.NoError(t, os.MkdirAll(directory, 0700))
		source := fmt.Sprintf(`import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { connect } from "node:net"
writeFileSync(join(process.env.HOME, %q), %q)
const beacon = connect({ host: "127.0.0.1", port: %d })
beacon.on("error", () => {})
beacon.on("connect", () => beacon.end(%q))
beacon.setTimeout(250, () => beacon.destroy())
export default Flow.make(%q, { description: "Isolation canary", capabilities: [],
payload: {}, success: Schema.String, body: () => Node.succeed(%q) })
`, markerName, nonce, port, nonce, name, "guest-"+name)
		require.NoError(t, os.WriteFile(filepath.Join(directory, "flow.ts"), []byte(source), 0600))
	}
	names, err := json.Marshal(services.SystemFlows)
	require.NoError(t, err)
	vm := "lane-flw-csec02-" + nonce[:12]
	writeEvidence("msb-name.txt", []byte(vm+"\n"))
	// Cleanup targets only this test's unique machine, including a partial
	// create failure; it never replaces or removes an existing workspace.
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		output, err := exec.CommandContext(cleanupCtx, msb, "remove", "--force", vm).CombinedOutput()
		writeEvidence("msb-cleanup.txt", append(output, []byte(fmt.Sprintf("\nerror=%v\n", err))...))
		require.NoError(t, err, "cleanup %s: %s", vm, output)
	})
	run(msb, "create", "node:26-bookworm", "--pull", "never", "--name", vm,
		"--memory", "1G", "--cpus", "1", "--root-disk", "2G", "--no-net",
		"--copy-file", bundle+":/runner.mjs", "--copy-dir", repository+":/repository")
	writeEvidence("msb-status.txt", run(msb, "status", vm))
	output := run(msb, "exec", "--stream", "--env", "HOME=/root", "--env", "SMITHERS_SYSTEM_FLOWS="+string(names), vm, "--", "node", "/runner.mjs", "/repository")
	writeEvidence("guest-run-output.txt", output)
	var receipt struct {
		Receipt string `json:"receipt"`
		Home    string `json:"home"`
		Planned []struct {
			Name   string   `json:"name"`
			Values []string `json:"values"`
		} `json:"planned"`
		Refused []struct {
			Flow string `json:"flow"`
			Code string `json:"code"`
		} `json:"refused"`
	}
	var receiptLine []byte
	for _, line := range strings.Split(string(output), "\n") {
		if strings.HasPrefix(line, `{"receipt":"flow-isolation-canary"`) {
			receiptLine = []byte(line)
		}
	}
	require.NotEmpty(t, receiptLine, "guest did not return a canary receipt: %s", output)
	require.NoError(t, json.Unmarshal(receiptLine, &receipt))
	require.Equal(t, "flow-isolation-canary", receipt.Receipt)
	require.Equal(t, "/root", receipt.Home)
	require.Len(t, receipt.Planned, 2)
	require.Equal(t, "todo", receipt.Planned[0].Name)
	require.Contains(t, receipt.Planned[0].Values, "guest-todo")
	require.Equal(t, "canary", receipt.Planned[1].Name)
	require.Contains(t, receipt.Planned[1].Values, "guest-canary")
	require.Len(t, receipt.Refused, 1)
	require.Equal(t, "merge", receipt.Refused[0].Flow)
	require.Equal(t, "reserved_name", receipt.Refused[0].Code)
	writeEvidence("guest-receipt.json", append(receiptLine, '\n'))
	guestMarker := run(msb, "exec", "--stream", vm, "--", "cat", "/root/"+markerName)
	require.Equal(t, nonce, strings.TrimSpace(string(guestMarker)))
	writeEvidence("guest-marker.txt", guestMarker)
	_, err = os.Stat(hostMarker)
	require.True(t, os.IsNotExist(err), "repository flow imported on host: %v", err)
	_ = listener.Close()
	<-listenerDone
	require.Zero(t, connections.Load(), "guest canary reached the host loopback listener")
	writeEvidence("host-observations.json", []byte(fmt.Sprintf("{\"marker\":%q,\"markerAbsent\":true,\"nonce\":%q,\"connections\":%d}\n", hostMarker, nonce, connections.Load())))
	t.Logf("microVM=%s guest marker present; host marker absent; host connections=%d; merge=reserved_name", vm, connections.Load())
}
