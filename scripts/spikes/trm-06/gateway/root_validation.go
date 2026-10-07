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
	if entry.Mode != 0644 || entry.Stage != "trm06" {
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
	if operation == "check-session" {
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
	scenarios := []string{"symlink-opt", "symlink-run", "existing-prototype", "race-parent", "poison-imports", "branch-supervisor", "bad-sha", "positive"}
	if operation == "check-session" {
		scenarios = []string{"positive"}
	}
	for _, scenario := range scenarios {
		if err = validationScenario(ctx, a, runtime, cfg.Root, home, string(fixture), scenario, operation, evidence); err != nil {
			return err
		}
	}
	receipt["status"] = "partial-pass"
	receipt["accepted"] = false
	// This executable campaign does not pretend its current fixture subset covers
	// the complete check. Preserve all samples; the reference lane must add/execute
	// the remaining poison/race/SFTP/restart controls before issuing PASS.
	receipt["pending_controls"] = []string{"installed artifact replacement/races", "independent restart admission ordering"}
	fmt.Printf("{\"check\":%q,\"status\":\"partial-pass\",\"evidence\":%q}\n", check, evidence)
	return errors.New("root validation incomplete: pending controls retained in receipt")
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
	observe := func(mode string) ([]byte, error) {
		// Only a literal, installed fixture selector is appended; no member code or
		// path is evaluated by root. The source and selectors are bundle controlled.
		return runGuestFixture(ctx, a, home, metadata.Machine, fixture, mode)
	}
	prepare := scenario
	if scenario == "branch-supervisor" || scenario == "bad-sha" {
		prepare = "positive"
	}
	before, err := observe(prepare)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, scenario+"-before.json"), before, 0600); err != nil {
		return err
	}
	identity := bootIdentity{}
	if _, err = rand.Read(identity.Boot[:]); err != nil {
		return err
	}
	if _, err = rand.Read(identity.Secret[:]); err != nil {
		return err
	}
	candidate := *a
	if scenario == "branch-supervisor" {
		candidate.supervisor = []byte("#!/bin/sh\nprintf canary >> /var/tmp/trm06-outside\n")
	}
	if scenario == "bad-sha" {
		candidate.supervisorSHA = "0000000000000000000000000000000000000000000000000000000000000000"
	}
	err = installPrototype(ctx, &candidate, id, home, runtimeRoot, identity)
	if scenario != "positive" && scenario != "poison-imports" {
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
	if mode != "positive" && mode != "race-parent" && mode != "poison-imports" && mode != "symlink-opt" && mode != "symlink-run" && mode != "existing-prototype" && mode != "sample" && mode != "fingerprint" && mode != "restart" {
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
	for i, request := range []string{
		`{"type":"open_session","kind":"exec","argv":["/bin/sh","-c","printf canary > /var/tmp/trm06-outside"],"uid":0}`,
		`{"type":"open_session","kind":"exec","argv":["/bin/sh"],"user":"agent"}`,
		`{"type":"close_session","id":"../../outside"}`,
		`{"type":"open_session","kind":"tcp","port":0}`,
		`{"type":"open_session","kind":"exec","kind":"pty","argv":["/bin/sh"]}`,
	} {
		stream, err := control.connect(ctx)
		if err != nil {
			return err
		}
		stream.SetDeadline(time.Now().Add(5 * time.Second))
		err = binary.Write(stream, binary.BigEndian, uint32(len(request)))
		if err == nil {
			err = writeAll(stream, []byte(request))
		}
		if err != nil {
			stream.Close()
			return err
		}
		var length uint32
		err = binary.Read(stream, binary.BigEndian, &length)
		if err == nil {
			if length > 4096 {
				stream.Close()
				return errors.New("oversized refusal")
			}
			body := make([]byte, length)
			_, err = io.ReadFull(stream, body)
			var reply controlReply
			if err == nil && strictControlReply(body, &reply) == nil && reply.Code == "" {
				stream.Close()
				return errors.New("invalid root session envelope accepted")
			}
			_ = os.WriteFile(filepath.Join(evidence, fmt.Sprintf("refusal-%d.json", i)), body, 0600)
		}
		stream.Close()
	}
	for _, bad := range []string{`{"type":"signal","name":"STOP"}`, `{"type":"signal","name":"TERM","uid":0}`, `{"type":"window","bytes":0}`, `{"type":"window","bytes":262145}`, `{"type":"data","stream":3,"bytes":[1]}`} {
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
	if err = sftpFixture(client); err != nil {
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
	return os.WriteFile(filepath.Join(evidence, "identity-cgroup-sample.json"), sample, 0600)
}
