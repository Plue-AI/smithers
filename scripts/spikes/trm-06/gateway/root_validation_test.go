package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRootEnvelopeRefusalRequiresUnambiguousEvidence(t *testing.T) {
	for _, test := range []struct {
		name, body                    string
		length                        uint32
		close, partial, timeout, pass bool
	}{
		{name: "explicit", body: `{"class":"invalid","code":"session_refused"}`, pass: true},
		{name: "closed", close: true, pass: true},
		{name: "success", body: `{"ok":true}`},
		{name: "wrong-class", body: `{"class":"unavailable","code":"session_refused"}`},
		{name: "duplicate", body: `{"class":"invalid","class":"invalid","code":"session_refused"}`},
		{name: "malformed", body: `{`},
		{name: "oversized", length: 4097},
		{name: "truncated", body: `{"class":"invalid","code":"session_refused"}`, partial: true},
		{name: "timeout", timeout: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			client, err := net.Dial("tcp", listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			server, err := listener.Accept()
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer server.Close()
				var length uint32
				if binary.Read(server, binary.BigEndian, &length) != nil {
					return
				}
				body := make([]byte, length)
				if _, err := io.ReadFull(server, body); err != nil {
					return
				}
				if string(body) != "invalid-fixture" {
					return
				}
				if test.close {
					return
				}
				if test.timeout {
					time.Sleep(2100 * time.Millisecond)
					return
				}
				length = uint32(len(test.body))
				if test.length != 0 {
					length = test.length
				}
				_ = binary.Write(server, binary.BigEndian, length)
				body = []byte(test.body)
				if test.partial {
					body = body[:1]
				}
				_ = writeAll(server, body)
			}()
			_, err = validationRefusal(client, []byte("invalid-fixture"), 15)
			if (err == nil) != test.pass {
				t.Fatalf("refusal evidence: %v, want passing=%v", err, test.pass)
			}
			client.Close()
			<-done
		})
	}
}

func TestTruncatedControlRequiresPeerClosure(t *testing.T) {
	for _, response := range []string{"close", "reply", "timeout"} {
		t.Run(response, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			done := make(chan struct{})
			go func() {
				defer close(done)
				var payload [5]byte
				if _, err := io.ReadFull(server, payload[:]); err != nil {
					return
				}
				if payload != [5]byte{0, 0, 0, 40, '{'} {
					return
				}
				switch response {
				case "close":
					server.Close()
				case "reply":
					server.Write([]byte{1})
				case "timeout":
					<-time.After(4100 * time.Millisecond)
				}
			}()
			err := validationTruncated(client, []byte{0, 0, 0, 40, '{'})
			if (err == nil) != (response == "close") {
				t.Fatalf("%v", err)
			}
			client.Close()
			<-done
		})
	}
}

func TestStartupObservationRequiresLiteralIdentityEnvironmentAndBytes(t *testing.T) {
	for _, test := range []struct {
		name, body string
		pass       bool
	}{
		{"positive", `{"supervisor_inputs":[{"pid":17,"uid":"0\t0\t0\t0","environment":["PATH=/usr/bin:/bin:/usr/sbin:/sbin"],"sha256":"main-digest"}]}`, true},
		{"missing", `{}`, false},
		{"multiple", `{"supervisor_inputs":[{},{}]}`, false},
		{"poison", `{"supervisor_inputs":[{"pid":17,"uid":"0 0 0 0","environment":["PATH=/workspace","PYTHONPATH=/workspace"],"sha256":"main-digest"}]}`, false},
		{"branch", `{"supervisor_inputs":[{"pid":17,"uid":"0 0 0 0","environment":["PATH=/usr/bin:/bin:/usr/sbin:/sbin"],"sha256":"branch-digest"}]}`, false},
		{"uid", `{"supervisor_inputs":[{"pid":17,"uid":"0 20001 0 0","environment":["PATH=/usr/bin:/bin:/usr/sbin:/sbin"],"sha256":"main-digest"}]}`, false},
		{"pid", `{"supervisor_inputs":[{"pid":0,"uid":"0 0 0 0","environment":["PATH=/usr/bin:/bin:/usr/sbin:/sbin"],"sha256":"main-digest"}]}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateStartupObservation([]byte(test.body), "main-digest"); (err == nil) != test.pass {
				t.Fatalf("got %v, pass=%v", err, test.pass)
			}
		})
	}
}

func TestCgroupRestartControlsInstallBeforeMutation(t *testing.T) {
	for _, name := range []string{"cgroup-writable", "cgroup-parent-replaced", "cgroup-child-writable"} {
		if !cgroupRestartFixture(name) {
			t.Fatalf("%s must reach installed restart boundary", name)
		}
	}
	for _, name := range []string{"positive", "race-parent", "branch-supervisor", "", "../cgroup-writable"} {
		if cgroupRestartFixture(name) {
			t.Fatalf("%s is not an installed cgroup restart control", name)
		}
	}
}

func TestStartupEnvironmentFixturesAreClosedAndIndependent(t *testing.T) {
	expected := map[string]string{
		"PATH": "/workspace", "HOME": "/workspace", "PYTHONPATH": "/workspace",
		"PYTHONHOME": "/workspace", "PYTHONSTARTUP": "/workspace/sitecustomize.py",
		"LD_PRELOAD": "/workspace/canary.so", "LD_LIBRARY_PATH": "/workspace",
		"DYLD_INSERT_LIBRARIES": "/workspace/canary.dylib", "DYLD_LIBRARY_PATH": "/workspace",
		"BASH_ENV": "/workspace/sitecustomize.py", "ENV": "/workspace/sitecustomize.py", "MSB_BACKEND": "remote",
	}
	all, ok := startupEnvironmentFixture("environment-all")
	if !ok || len(all) != len(expected) {
		t.Fatalf("incomplete combined fixture: %v", all)
	}
	for name, want := range expected {
		one, ok := startupEnvironmentFixture("environment-" + name)
		if !ok || len(one) != 1 || one[name] != want || all[name] != want {
			t.Fatalf("bad fixture %s: %v", name, one)
		}
		one[name] = "mutated"
	}
	all["PATH"] = "mutated"
	next, _ := startupEnvironmentFixture("environment-all")
	if next["PATH"] != "/workspace" {
		t.Fatal("fixture mutation escaped its invocation")
	}
	for _, name := range []string{"", "positive", "environment-", "environment-USER", "environment-PATH=/canary", "../environment-all"} {
		if _, ok := startupEnvironmentFixture(name); ok {
			t.Fatalf("unknown environment selector accepted: %q", name)
		}
	}
}

func TestRootScenarioEvidencePreservesEverySample(t *testing.T) {
	root := t.TempDir()
	for _, scenario := range []string{"positive", "poison-imports", "environment-PATH", "environment-all"} {
		directory, err := rootScenarioEvidence(root, scenario)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(directory, "positive-after.json"), []byte(scenario), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, scenario := range []string{"positive", "poison-imports", "environment-PATH", "environment-all"} {
		if _, err := rootScenarioEvidence(root, scenario); err == nil {
			t.Fatal("duplicate evidence directory accepted")
		}
		body, err := os.ReadFile(filepath.Join(root, scenario, "positive-after.json"))
		if err != nil || string(body) != scenario {
			t.Fatalf("sample overwritten: %q %v", body, err)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.Symlink(outside, filepath.Join(root, "symlink")); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"", ".", "..", "../outside", outside, "symlink"} {
		if _, err := rootScenarioEvidence(root, scenario); err == nil {
			t.Fatalf("invalid/reused directory accepted: %q", scenario)
		}
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatal("outside evidence path changed")
	}
}

func TestRootObservationsRetainFailureAndRefuseLostEvidence(t *testing.T) {
	root := t.TempDir()
	failure := errors.New("installed fixture failed")
	for index, observeErr := range []error{nil, failure} {
		raw := []byte{0, 255, byte(index)}
		err := retainGuestObservation(root, index, "sample", raw, observeErr)
		if !errors.Is(err, observeErr) {
			t.Fatalf("observation error lost: %v", err)
		}
		stem := filepath.Join(root, fmt.Sprintf("observation-%03d", index))
		stored, err := os.ReadFile(stem + ".raw")
		if err != nil || !bytes.Equal(stored, raw) {
			t.Fatalf("raw failed output lost: %v", err)
		}
		metadata, err := os.ReadFile(stem + ".json")
		var result struct {
			Operation string `json:"operation"`
			Error     string `json:"error"`
			Bytes     int    `json:"bytes"`
			UTC       string `json:"observed_utc"`
		}
		if err != nil || json.Unmarshal(metadata, &result) != nil || result.Operation != "sample" || result.Bytes != 3 || result.UTC == "" {
			t.Fatalf("missing observation metadata: %s %v", metadata, err)
		}
		if (result.Error == "") != (observeErr == nil) {
			t.Fatalf("failure metadata lost: %s", metadata)
		}
	}
	for _, observeErr := range []error{nil, failure} {
		err := retainGuestObservation(filepath.Join(root, "missing"), 1, "sample", []byte("raw"), observeErr)
		if err == nil || (observeErr != nil && !errors.Is(err, failure)) {
			t.Fatalf("lost evidence did not refuse: %v", err)
		}
	}
}

func TestInstalledStartupMatrixHasEveryLiteralMutation(t *testing.T) {
	names := startupMutationScenarios()
	if len(names) != 38 {
		t.Fatalf("startup controls: %d", len(names))
	}
	seen := map[string]bool{}
	for _, name := range append(names, "boot-symlink", "boot-writable", "supervisor-replaced") {
		if seen[name] || !startupMutationFixture(name) {
			t.Fatalf("invalid scenario %q", name)
		}
		seen[name] = true
	}
	for _, bad := range []string{"", "startup-boot-root", "startup-boot-parent-../", "startup-boot-parent-canary"} {
		if startupMutationFixture(bad) {
			t.Fatalf("member selector admitted: %s", bad)
		}
	}
}

func TestInstalledDestinationMatrixUsesFixedSelectors(t *testing.T) {
	names := installMutationScenarios()
	if len(names) != 16 {
		t.Fatalf("destination controls: %d", len(names))
	}
	for _, name := range names {
		if !installMutationFixture(name) || startupMutationFixture(name) {
			t.Fatalf("wrong dispatch: %s", name)
		}
	}
	for _, name := range []string{"install-root-owner", "install-opt-symlink", "install-opt-parent-../", "install-state-dangling --path=/"} {
		if installMutationFixture(name) {
			t.Fatalf("caller selector: %s", name)
		}
	}
}
