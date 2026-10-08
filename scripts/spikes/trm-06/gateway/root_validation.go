package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspace "github.com/smithersai/smithers/packages/backend/workspace"
	"golang.org/x/crypto/ssh"
)

// Installed-only subchecks. They remain behind the same five accepted checks;
// there is deliberately no test flag, caller key or validation grant that can
// bypass the ticket's activation requirement. Security-owner acceptance must
// resolve initial validation authorization externally, not via a branch switch.
func runRootValidation(ctx context.Context, a *installedAuthority, root, home, operation string) (checkErr error) {
	lock, err := lockRun(root)
	if err != nil {
		return err
	}
	defer lock.Close()
	fixture, entry, err := a.bundle.Read("share/trm06/validation.py", 65536)
	if err != nil {
		return err
	}
	if entry.Mode != 0644 || entry.Stage != "host" {
		return errAuthority
	}
	cfg := freshConfig()
	cfg.Bundle = a.bundle
	cfg.Root = filepath.Join(root, "validation-runtime")
	runtime, err := microsandbox.New(ctx, cfg)
	if err != nil {
		return err
	}
	defer runtime.Close()
	evidence := filepath.Join(root, "evidence", time.Now().UTC().Format("20060102T150405.000000000Z"))
	if err = os.MkdirAll(evidence, 0700); err != nil {
		return err
	}
	check := "C-SPK-08/root-prototype-install-validation"
	if operation == "check-session" || operation == "check-no-landlock" {
		check = "C-SPK-08/root-session-input-validation"
	}
	receipt := map[string]any{"check": check, "revision": a.bundle.Revision(), "status": "NO"}
	defer func() {
		if checkErr != nil {
			receipt["failure"] = checkErr.Error()
		}
		body, _ := json.MarshalIndent(receipt, "", "  ")
		_ = os.WriteFile(filepath.Join(evidence, "receipt.json"), body, 0600)
	}()
	scenarios := []string{"symlink-opt", "symlink-run", "existing-prototype", "race-parent", "poison-imports", "branch-supervisor", "bad-sha", "boot-symlink", "boot-writable", "supervisor-replaced", "positive"}
	if operation == "check-session" {
		scenarios = []string{"positive", "device-regular", "cleanup-poison", "cgroup-writable", "cgroup-parent-replaced", "cgroup-child-writable"}
	}
	if operation == "check-no-landlock" {
		scenarios = []string{"no-landlock"}
	}
	if operation == "check-install" {
		names := make([]string, 0, len(startupEnvironmentPoisons))
		for name := range startupEnvironmentPoisons {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			scenarios = append(scenarios, "environment-"+name)
		}
		scenarios = append(scenarios, "environment-all")
	}
	type scenarioReceipt struct {
		Scenario string `json:"scenario"`
		Evidence string `json:"evidence"`
		Status   string `json:"status"`
		Failure  string `json:"failure,omitempty"`
	}
	completed := make([]scenarioReceipt, 0, len(scenarios))
	for _, scenario := range scenarios {
		scenarioEvidence, directoryErr := rootScenarioEvidence(evidence, scenario)
		if directoryErr != nil {
			return directoryErr
		}
		result := scenarioReceipt{Scenario: scenario, Evidence: scenarioEvidence, Status: "NO"}
		err = validationScenario(ctx, a, runtime, cfg.Root, home, string(fixture), scenario, operation, scenarioEvidence)
		if err != nil {
			result.Failure = err.Error()
		} else {
			result.Status = "pass"
		}
		completed = append(completed, result)
		receipt["scenarios"] = completed
		if err != nil {
			return err
		}
	}
	receipt["status"] = "partial-pass"
	receipt["accepted"] = false
	// This executable campaign does not pretend its current fixture subset covers
	// the complete check. Preserve all samples; the reference lane must add/execute
	// the remaining poison/race/SFTP/restart controls before issuing PASS.
	receipt["pending_controls"] = []string{"installed host launcher/artifact/destination replacement races", "installed host startup environment controls", "cgroup/path replacement races", "execution of installed unsupported-Landlock kernel variant"}
	fmt.Printf("{\"check\":%q,\"status\":\"partial-pass\",\"evidence\":%q}\n", check, evidence)
	return errors.New("root validation incomplete: pending controls retained in receipt")
}

// Isolate all samples, including the formerly shared positive-after.json and
// session/SSH fixture names. A duplicate scenario must refuse, never reuse and
// overwrite an earlier sample directory.
func rootScenarioEvidence(evidence, scenario string) (string, error) {
	if scenario == "" || scenario == "." || scenario == ".." || filepath.Base(scenario) != scenario {
		return "", errors.New("invalid root scenario evidence name")
	}
	path := filepath.Join(evidence, scenario)
	if err := os.Mkdir(path, 0700); err != nil {
		return "", err
	}
	return path, nil
}

// Retain raw fixture output before checking success or parsing policy samples.
// A failed fixture's stderr/partial output is evidence too; failed storage never
// permits a passing control. Numeric names keep selectors out of file paths.
func retainGuestObservation(evidence string, index int, mode string, body []byte, observeErr error) error {
	stem := filepath.Join(evidence, fmt.Sprintf("observation-%03d", index))
	if err := os.WriteFile(stem+".raw", body, 0600); err != nil {
		return errors.Join(observeErr, err)
	}
	result := map[string]any{"operation": mode, "observed_utc": time.Now().UTC().Format(time.RFC3339Nano), "bytes": len(body), "error": ""}
	if observeErr != nil {
		result["error"] = observeErr.Error()
	}
	metadata, err := json.Marshal(result)
	if err == nil {
		err = os.WriteFile(stem+".json", metadata, 0600)
	}
	return errors.Join(observeErr, err)
}

// Each poison is exercised independently and together in fresh disposable VMs.
// The independently sampled supervisor must still have the literal PATH-only
// environment; unchanged sentinel bytes detect workspace import execution.
var startupEnvironmentPoisons = map[string]string{
	"PATH": "/workspace", "HOME": "/workspace", "PYTHONPATH": "/workspace",
	"PYTHONHOME": "/workspace", "PYTHONSTARTUP": "/workspace/sitecustomize.py",
	"LD_PRELOAD": "/workspace/canary.so", "LD_LIBRARY_PATH": "/workspace",
	"DYLD_INSERT_LIBRARIES": "/workspace/canary.dylib", "DYLD_LIBRARY_PATH": "/workspace",
	"BASH_ENV": "/workspace/sitecustomize.py", "ENV": "/workspace/sitecustomize.py",
	"MSB_BACKEND": "remote",
}

func startupEnvironmentFixture(scenario string) (map[string]string, bool) {
	if scenario == "environment-all" {
		values := make(map[string]string, len(startupEnvironmentPoisons))
		for name, value := range startupEnvironmentPoisons {
			values[name] = value
		}
		return values, true
	}
	if strings.HasPrefix(scenario, "environment-") {
		name := strings.TrimPrefix(scenario, "environment-")
		if value, ok := startupEnvironmentPoisons[name]; ok {
			return map[string]string{name: value}, true
		}
	}
	return nil, false
}

func cgroupRestartFixture(scenario string) bool {
	switch scenario {
	case "cgroup-writable", "cgroup-parent-replaced", "cgroup-child-writable":
		return true
	default:
		return false
	}
}

func validationScenario(ctx context.Context, a *installedAuthority, runtime *microsandbox.Runtime, runtimeRoot, home, fixture, scenario, operation, evidence string) error {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	id := "trm06-check-" + hex.EncodeToString(random[:])
	if _, err := runtime.CreateWorkspace(ctx, workspace.WorkspaceSpec{ID: id}); err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_ = runtime.DeleteWorkspace(cleanup, id)
	}()
	digest := sha256.Sum256([]byte(id))
	data, err := readState(filepath.Join(runtimeRoot, "workspaces", hex.EncodeToString(digest[:]), "metadata.json"), 65536)
	if err != nil {
		return err
	}
	var metadata struct {
		ID      string `json:"id"`
		Machine string `json:"machine"`
	}
	if json.Unmarshal(data, &metadata) != nil || metadata.ID != id || metadata.Machine == "" {
		return errAuthority
	}
	observation := 0
	observe := func(mode string) ([]byte, error) {
		// Only a literal, installed fixture selector is appended; no member code or
		// path is evaluated by root. The source and selectors are bundle controlled.
		observation++
		body, observeErr := runGuestFixture(ctx, a, home, metadata.Machine, fixture, mode)
		return body, retainGuestObservation(evidence, observation, mode, body, observeErr)
	}
	environment, environmentFixture := startupEnvironmentFixture(scenario)
	prepare := scenario
	if environmentFixture {
		prepare = "poison-imports"
	}
	if scenario == "no-landlock" || scenario == "branch-supervisor" || scenario == "bad-sha" || scenario == "device-regular" || scenario == "cleanup-poison" || cgroupRestartFixture(scenario) || scenario == "boot-symlink" || scenario == "boot-writable" || scenario == "supervisor-replaced" {
		prepare = "positive"
	}
	before, err := observe(prepare)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, scenario+"-before.json"), before, 0600); err != nil {
		return err
	}
	if scenario == "no-landlock" {
		kernel, kernelErr := observe("landlock-kernel")
		if kernelErr != nil {
			return kernelErr
		}
		if kernelErr = requireUnsupportedLandlock(kernel); kernelErr != nil {
			return kernelErr
		}
	}
	identity := bootIdentity{}
	if _, err = rand.Read(identity.Boot[:]); err != nil {
		return err
	}
	if _, err = rand.Read(identity.Secret[:]); err != nil {
		return err
	}
	candidate := *a
	if environmentFixture {
		// Literal main-installed fixture bytes only. Poison the installer process
		// before its imports/start; never take environment selectors from members.
		values, _ := json.Marshal(environment)
		candidate.installer = append([]byte("import os\nos.environ.update("+string(values)+")\n"), a.installer...)
	}
	if scenario == "branch-supervisor" {
		candidate.supervisor = []byte("#!/bin/sh\nprintf canary >> /var/tmp/trm06-outside\n")
	}
	if scenario == "bad-sha" {
		candidate.supervisorSHA = "0000000000000000000000000000000000000000000000000000000000000000"
	}
	err = installPrototype(ctx, &candidate, id, home, runtimeRoot, identity)
	if scenario != "no-landlock" && !environmentFixture && scenario != "positive" && scenario != "poison-imports" && scenario != "device-regular" && scenario != "cleanup-poison" && !cgroupRestartFixture(scenario) && scenario != "boot-symlink" && scenario != "boot-writable" && scenario != "supervisor-replaced" {
		if err == nil {
			return fmt.Errorf("installed destination fixture %s was accepted", scenario)
		}
		// The root fixture's sample mode is unavailable until cgroups exist; use
		// fingerprint-only mode independently of any supervisor/helper policy.
		after, err := observe("fingerprint")
		if err != nil {
			return err
		}
		if err = os.WriteFile(filepath.Join(evidence, scenario+"-after.json"), after, 0600); err != nil {
			return err
		}
		return compareOutside(before, after)
	}
	if err != nil {
		return err
	}
	control := relayControl{runtime: runtime, workspaceID: id, authenticate: identity.authenticate}
	ready, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		connection, err := control.connect(ready)
		if err == nil {
			connection.Close()
			break
		}
		select {
		case <-ready.Done():
			return ready.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	startup, err := observe("sample")
	if err != nil {
		return err
	}
	if err = validateStartupObservation(startup, a.supervisorSHA); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, scenario+"-startup.json"), startup, 0600); err != nil {
		return err
	}
	if scenario == "device-regular" || scenario == "cleanup-poison" || cgroupRestartFixture(scenario) || scenario == "boot-symlink" || scenario == "boot-writable" || scenario == "supervisor-replaced" {
		return validateRefusalFixture(ctx, control, observe, scenario, before, evidence)
	}
	if scenario == "no-landlock" {
		return validateNoLandlockBoundary(ctx, control, observe, before, evidence)
	}
	if operation == "check-session" {
		if err = validateSessionBoundary(ctx, control, observe, evidence); err != nil {
			return err
		}
	}
	if err = control.revoke(ctx); err != nil {
		return err
	}
	after, err := observe("sample")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, "positive-after.json"), after, 0600); err != nil {
		return err
	}
	var sample struct {
		Processes []json.RawMessage `json:"processes"`
	}
	if json.Unmarshal(after, &sample) != nil || len(sample.Processes) != 0 {
		return errors.New("independent observer found surviving Ben processes")
	}
	return compareOutside(before, after)
}

// /proc observations are independent of boot declarations and runtime policy.
func validateStartupObservation(body []byte, expectedSHA string) error {
	var state struct {
		Inputs []struct {
			PID         int      `json:"pid"`
			UID         string   `json:"uid"`
			Environment []string `json:"environment"`
			SHA         string   `json:"sha256"`
		} `json:"supervisor_inputs"`
	}
	if json.Unmarshal(body, &state) != nil || len(state.Inputs) != 1 {
		return errors.New("independent startup inputs unavailable")
	}
	input := state.Inputs[0]
	if input.PID <= 0 || strings.Join(strings.Fields(input.UID), " ") != "0 0 0 0" || input.SHA != expectedSHA || len(input.Environment) != 1 || input.Environment[0] != "PATH=/usr/bin:/bin:/usr/sbin:/sbin" {
		return errors.New("independent startup executable/identity/environment mismatch")
	}
	return nil
}

func compareOutside(before, after []byte) error {
	var a, b struct {
		Outside json.RawMessage `json:"outside"`
	}
	if json.Unmarshal(before, &a) != nil || json.Unmarshal(after, &b) != nil || len(a.Outside) == 0 || !bytes.Equal(a.Outside, b.Outside) {
		return errors.New("outside sentinel bytes/owner/mode changed")
	}
	// Independent literal fingerprint, not a helper/fixture policy value.
	var state struct {
		SHA  string `json:"sha256"`
		UID  uint32 `json:"uid"`
		Mode uint32 `json:"mode"`
	}
	expected := sha256.Sum256([]byte("outside-fixture\x00"))
	if json.Unmarshal(a.Outside, &state) != nil || state.SHA != hex.EncodeToString(expected[:]) || state.UID != 20001 || state.Mode != 0640 {
		return errors.New("outside fixture identity mismatch")
	}
	return nil
}
func runGuestFixture(ctx context.Context, a *installedAuthority, home, machine, source, mode string) ([]byte, error) {
	if mode != "landlock-kernel" && mode != "positive" && mode != "race-parent" && mode != "poison-imports" && mode != "symlink-opt" && mode != "symlink-run" && mode != "existing-prototype" && mode != "sample" && mode != "fingerprint" && mode != "restart" && mode != "arm" && mode != "drain" && mode != "device-regular" && mode != "cleanup-poison" && mode != "cgroup-writable" && mode != "cgroup-parent-replaced" && mode != "cgroup-child-writable" && mode != "boundary-sample" && mode != "boot-symlink" && mode != "boot-writable" && mode != "supervisor-replaced" {
		return nil, errAuthority
	}
	// Set argv in install-controlled source, never concatenate member data or
	// shell syntax. A JSON literal is also a valid Python string here.
	selector, _ := json.Marshal(mode)
	return runGuestInstalled(ctx, a, home, machine, "import sys\nsys.argv=['installed-fixture',"+string(selector)+"]\n"+source, nil)
}
func validateSessionBoundary(ctx context.Context, control relayControl, observe func(string) ([]byte, error), evidence string) error {
	wrong := control
	identityBad := bootIdentity{Boot: [16]byte{1}, Secret: [32]byte{1}}
	wrong.authenticate = identityBad.authenticate
	if stream, err := wrong.connect(ctx); err == nil {
		stream.Close()
		return errors.New("forged boot accepted")
	}
	requests := []string{
		`{`, `null`, `[]`, `{} trailing`,
		`{"type":"open_session","kind":"exec","argv":["/bin/sh"],"uid":0}`,
		`{"type":"open_session","kind":"exec","argv":["/bin/sh"],"user":"agent"}`,
		`{"type":"open_session","kind":"exec","argv":["/bin/sh"],"gid":0}`,
		`{"type":"open_session","kind":"exec","argv":["/bin/sh"],"groups":[0]}`,
		`{"type":"open_session","kind":"exec","argv":["/bin/sh"],"cwd":"/home/agent"}`,
		`{"type":"open_session","kind":"exec","argv":["/bin/sh"],"env":{"PATH":"/workspace"}}`,
		`{"type":"open_session","kind":"exec","argv":["/bin/sh"],"cgroup":"../../outside"}`,
		`{"type":"close_session","id":"../../outside"}`,
		`{"type":"close_session","id":"s-0000000000000000"}`,
		`{"type":"attach_session","id":"../../outside","received":0}`,
		`{"type":"attach_session","id":"s-0000000000000000","received":18446744073709551615}`,
		`{"type":"kill_sessions","user":"agent"}`,
		`{"type":"restart","cgroup":"/"}`,
		`{"type":"open_session","kind":"tcp","port":0}`,
		`{"type":"open_session","kind":"tcp","port":65536}`,
		`{"type":"open_session","kind":"tcp","port":3000,"host":"192.0.2.1"}`,
		`{"type":"open_session","kind":"exec","kind":"pty","argv":["/bin/sh"]}`,
		`{"type":"open_session","kind":"exec","argv":["/bin/sh\u0000"]}`,
	}
	for i, request := range requests {
		stream, err := control.connect(ctx)
		if err != nil {
			return err
		}
		body, err := validationRefusal(stream, []byte(request), uint32(len(request)))
		stream.Close()
		if err != nil {
			return fmt.Errorf("envelope fixture %d: %w", i, err)
		}
		if err = os.WriteFile(filepath.Join(evidence, fmt.Sprintf("refusal-%d.json", i)), body, 0600); err != nil {
			return err
		}
	}
	for _, length := range []uint32{0, 65537, 4294967295} {
		stream, err := control.connect(ctx)
		if err != nil {
			return err
		}
		body, err := validationRefusal(stream, nil, length)
		stream.Close()
		if err != nil {
			return fmt.Errorf("length fixture %d: %w", length, err)
		}
		if err = os.WriteFile(filepath.Join(evidence, fmt.Sprintf("length-%d.json", length)), body, 0600); err != nil {
			return err
		}
	}
	// Leave authenticated partial envelopes open: only supervisor-side expiry
	// proves bounded handling. A caller timeout or our own close is not evidence.
	for i, payload := range [][]byte{{0}, {0, 0, 0, 40, '{'}} {
		stream, err := control.connect(ctx)
		if err != nil {
			return err
		}
		err = validationTruncated(stream, payload)
		stream.Close()
		if err != nil {
			return fmt.Errorf("truncated control %d: %w", i, err)
		}
		if err = os.WriteFile(filepath.Join(evidence, fmt.Sprintf("truncated-%d.json", i)), []byte(`{"transport_closed":true}`), 0600); err != nil {
			return err
		}
	}
	for _, bad := range []string{`{"type":"signal","name":"STOP"}`, `{"type":"signal","name":"TERM","uid":0}`, `{"type":"window","bytes":0}`, `{"type":"window","bytes":262145}`, `{"type":"data","stream":3,"bytes":[1]}`, `{"type":"data","stream":0,"bytes":[]}`, `{"type":"eof","stream":3}`, `{"type":"resize","cols":0,"rows":24}`, `{"type":"signal","name":"TERM","name":"KILL"}`, `{"type":"exit","code":0}`, `{"type":"data","stream":0,"bytes":[256]}`} {
		stream, err := control.connect(ctx)
		if err != nil {
			return err
		}
		if _, err = controlExchange(stream, map[string]any{"type": "open_session", "kind": "exec", "argv": []string{"/bin/sh", "-c", "sleep 100"}}); err != nil {
			stream.Close()
			return err
		}
		stream.SetDeadline(time.Now().Add(2 * time.Second))
		if err = binary.Write(stream, binary.BigEndian, uint32(len(bad))); err == nil {
			err = writeAll(stream, []byte(bad))
		}
		if err != nil {
			stream.Close()
			return err
		}
		for {
			var length uint32
			err = binary.Read(stream, binary.BigEndian, &length)
			if err != nil {
				break
			}
			if length > 65536 {
				stream.Close()
				return errors.New("oversized invalid-frame reply")
			}
			body := make([]byte, length)
			if _, err = io.ReadFull(stream, body); err != nil {
				break
			}
			var frame struct {
				Type  string `json:"type"`
				Bytes uint32 `json:"bytes"`
			}
			if json.Unmarshal(body, &frame) != nil || frame.Type != "window" || frame.Bytes != 262144 {
				stream.Close()
				return errors.New("invalid signal/credit changed the running fixture")
			}
		}
		stream.Close()
		if err != io.EOF {
			return fmt.Errorf("invalid frame did not close transport: %v", err)
		}
	}
	// Real SSH key/channel boundary over control's actual DialWorkspacePort relay.
	_, hostPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	host, err := ssh.NewSignerFromKey(hostPrivate)
	if err != nil {
		return err
	}
	_, benPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	ben, err := ssh.NewSignerFromKey(benPrivate)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	serving, cancel := context.WithCancel(ctx)
	defer cancel()
	served := make(chan error, 1)
	go func() {
		served <- serveListener(serving, listener, listenerAuthority{host, ben.PublicKey(), control.opener(serving)})
	}()
	defer func() { cancel(); <-served }()
	dial := func(user string) (*ssh.Client, error) {
		return ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: user, Auth: []ssh.AuthMethod{ssh.PublicKeys(ben)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: 5 * time.Second})
	}
	for _, user := range []string{"root", "agent"} {
		if client, err := dial(user); err == nil {
			client.Close()
			return errors.New("other-user SSH admitted")
		}
	}
	client, err := dial("ben")
	if err != nil {
		return err
	}
	defer client.Close()
	command := func(text string) ([]byte, error) {
		session, err := client.NewSession()
		if err != nil {
			return nil, err
		}
		defer session.Close()
		return session.CombinedOutput(text)
	}
	identity, err := command("id -u; id -g; id -G; umask; pwd")
	if err != nil || string(identity) != "20001\n20001\n20001 20000\n0002\n/workspace\n" {
		return fmt.Errorf("literal dropped identity failed: %q %v", identity, err)
	}
	_ = os.WriteFile(filepath.Join(evidence, "identity.txt"), identity, 0600)
	for _, text := range []string{"printf canary > /var/tmp/trm06-outside", "ln -s /var/tmp/trm06-outside /workspace/trm06-escape; printf canary > /workspace/trm06-escape", "printf canary > /home/agent/trm06-private"} {
		if _, err := command(text); err == nil {
			return errors.New("outside/home write accepted")
		}
	}
	for _, fixture := range []string{"exit 7", "kill -TERM $$"} {
		_, err := command(fixture)
		var exit *ssh.ExitError
		if !errors.As(err, &exit) || (fixture == "exit 7" && exit.ExitStatus() != 7) || (fixture != "exit 7" && exit.Signal() != "TERM") {
			return errors.New("valid exec fixture failed")
		}
	}
	if err = sftpBoundaryFixture(client, true); err != nil {
		return err
	}
	if bytes, err := command("cat /workspace/trm06-sftp.txt; stat -c '%a %u %g' /workspace/trm06-sftp.txt"); err != nil || string(bytes) != "sftp-fixture\x00664 20001 20000\n" {
		return fmt.Errorf("SFTP bytes/umask fixture mismatch: %q %v", bytes, err)
	}
	if err = ptyFixture(client, evidence, map[string]any{}); err != nil {
		return err
	}
	if err = forwardFixture(client, evidence); err != nil {
		return err
	}
	sample, err := observe("sample")
	if err != nil {
		return err
	}
	var observed struct {
		Processes []struct {
			UID    string `json:"uid"`
			GID    string `json:"gid"`
			Groups string `json:"groups"`
			Cgroup string `json:"cgroup"`
		} `json:"processes"`
	}
	if json.Unmarshal(sample, &observed) != nil || len(observed.Processes) == 0 {
		return errors.New("independent process identity sample unavailable")
	}
	for _, process := range observed.Processes {
		if strings.Join(strings.Fields(process.UID), " ") != "20001 20001 20001 20001" || strings.Join(strings.Fields(process.GID), " ") != "20001 20001 20001 20001" || strings.Join(strings.Fields(process.Groups), " ") != "20000" || !strings.Contains(process.Cgroup, "/smithers/sessions/") {
			return errors.New("independent saved/real/effective identity or cgroup mismatch")
		}
	}
	if err = os.WriteFile(filepath.Join(evidence, "identity-cgroup-sample.json"), sample, 0600); err != nil {
		return err
	}
	return validateRestartBoundary(ctx, client, listener.Addr().String(), &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(ben)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey())}, observe, evidence)
}

// A timeout, malformed reply or unrelated response never proves refusal. EOF
// is acceptable only because this fully written request was rejected by closing
// the authenticated transport, and independent sentinel/process samples follow.
func validationRefusal(stream net.Conn, body []byte, length uint32) ([]byte, error) {
	if err := stream.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return nil, err
	}
	if err := binary.Write(stream, binary.BigEndian, length); err != nil {
		return nil, err
	}
	if len(body) > 0 {
		if err := writeAll(stream, body); err != nil {
			return nil, err
		}
	}
	var replyLength uint32
	if err := binary.Read(stream, binary.BigEndian, &replyLength); err != nil {
		if err == io.EOF {
			return []byte(`{"transport_closed":true}`), nil
		}
		return nil, err
	}
	if replyLength == 0 || replyLength > 4096 {
		return nil, errors.New("invalid refusal length")
	}
	replyBody := make([]byte, replyLength)
	if _, err := io.ReadFull(stream, replyBody); err != nil {
		return nil, err
	}
	var reply controlReply
	if err := strictControlReply(replyBody, &reply); err != nil {
		return nil, err
	}
	if reply.Class != "invalid" || reply.Code != "session_refused" {
		return nil, errors.New("invalid envelope lacked an explicit refusal")
	}
	return replyBody, nil
}

func validateRefusalFixture(ctx context.Context, control relayControl, observe func(string) ([]byte, error), scenario string, before []byte, evidence string) error {
	// Actual authenticated installed relay, never a direct supervisor socket.
	stream, err := control.connect(ctx)
	if err != nil {
		return err
	}
	defer stream.Close()
	if _, err = observe(scenario); err != nil {
		return err
	}
	if scenario == "device-regular" {
		_, err = controlExchange(stream, map[string]any{"type": "open_session", "kind": "exec", "argv": []string{"/bin/sh", "-c", "printf canary > /workspace/trm06-member-canary"}})
		if err == nil {
			return errors.New("replaced fixed device admitted member argv")
		}
		// Require a complete typed refusal. A transport timeout is not proof.
		stream.Close()
		probe, connectErr := control.connect(ctx)
		if connectErr != nil {
			return connectErr
		}
		body, refusalErr := validationRefusal(probe, []byte(`{"type":"open_session","kind":"exec","argv":["/bin/sh","-c","printf canary > /workspace/trm06-member-canary"]}`), uint32(len(`{"type":"open_session","kind":"exec","argv":["/bin/sh","-c","printf canary > /workspace/trm06-member-canary"]}`)))
		probe.Close()
		if refusalErr != nil || bytes.Equal(body, []byte(`{"transport_closed":true}`)) {
			return errors.New("device refusal lacked explicit envelope")
		}
	} else {
		if scenario == "cleanup-poison" || cgroupRestartFixture(scenario) {
			if _, err = observe("restart"); err != nil {
				return err
			}
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			attempt, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
			probe, connectErr := control.connect(attempt)
			cancel()
			if connectErr == nil {
				probe.Close()
				return errors.New("cleanup failure admitted authenticated relay")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	after, err := observe("boundary-sample")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, scenario+"-boundary.json"), after, 0600); err != nil {
		return err
	}
	var state struct {
		MemberCanaryExists *bool  `json:"member_canary_exists"`
		InitLog            string `json:"init_log"`
	}
	if json.Unmarshal(after, &state) != nil || state.MemberCanaryExists == nil || *state.MemberCanaryExists {
		return errors.New("member canary ran before device/startup validation")
	}
	if (scenario == "cleanup-poison" || cgroupRestartFixture(scenario)) && !strings.Contains(state.InitLog, "untrusted session cgroup") {
		return errors.New("cleanup failure lacked an explicit startup refusal")
	}
	if (scenario == "boot-symlink" || scenario == "boot-writable" || scenario == "supervisor-replaced") && !strings.Contains(state.InitLog, "prototype_authority_unavailable") {
		return errors.New("replaced boot/artifact lacked an explicit init refusal")
	}
	return compareOutside(before, after)
}

// The installed supervisor has a two-second absolute envelope deadline after
// its first byte. Keep the read side open longer to observe its actual refusal.
func validationTruncated(stream net.Conn, payload []byte) error {
	if err := stream.SetDeadline(time.Now().Add(4 * time.Second)); err != nil {
		return err
	}
	if err := writeAll(stream, payload); err != nil {
		return err
	}
	var byte [1]byte
	n, err := stream.Read(byte[:])
	if n != 0 || err != io.EOF {
		return fmt.Errorf("partial envelope lacked supervisor EOF: bytes=%d error=%v", n, err)
	}
	return nil
}
