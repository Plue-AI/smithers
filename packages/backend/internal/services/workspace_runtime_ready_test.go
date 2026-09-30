package services

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWorkspaceCloneWaitsForPinnedRuntime(t *testing.T) {
	for _, ready := range []bool{true, false} {
		t.Run(map[bool]string{true: "staging completes", false: "staging fails"}[ready], func(t *testing.T) {
			dir := t.TempDir()
			bin := filepath.Join(dir, "bin")
			if err := os.Mkdir(bin, 0755); err != nil {
				t.Fatal(err)
			}
			write := func(path, body string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(body), 0755); err != nil {
					t.Fatal(err)
				}
			}
			write(filepath.Join(bin, "jj"), "#!/bin/sh\necho jj 0.44.0\n")
			host := filepath.Join(bin, "coding-host")
			helper := filepath.Join(bin, "jj-export")
			hostPayload := filepath.Join(dir, "host.b64")
			helperPayload := filepath.Join(dir, "helper.b64")
			write(hostPayload+".part00000000", "pending")
			write(helperPayload+".part00000000", "pending")
			command := strings.NewReplacer(workspaceCodingHostB64Path, hostPayload, workspaceJJExportB64Path, helperPayload, workspaceCodingHostPath, host, workspaceJJExportPath, helper, "seq 1 120", "seq 1 20", "sleep 1", "sleep 0.05").Replace(workspaceRuntimeReadyCommand())
			marker := filepath.Join(dir, "cloned")
			cmd := exec.Command("bash", "-c", "set -euo pipefail\n"+command+"\ntouch '"+marker+"'")
			cmd.Env = append(os.Environ(), "PATH="+bin+":/usr/bin:/bin")
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			time.Sleep(100 * time.Millisecond)
			if _, err := os.Stat(marker); err == nil {
				t.Fatal("clone started with incompatible unstaged runtime")
			}
			if ready {
				write(filepath.Join(bin, "jj"), "#!/bin/sh\necho jj 0.39.0\n")
				write(host, "#!/bin/sh\necho 1.0.0\n")
				write(helper, "#!/bin/sh\necho smithers-jj-export 0.1.0\n")
			}
			err := cmd.Wait()
			if (err == nil) != ready {
				t.Fatalf("ready=%v exit=%v", ready, err)
			}
			_, err = os.Stat(marker)
			if (err == nil) != ready {
				t.Fatalf("clone marker=%v ready=%v", err, ready)
			}
		})
	}
	command := buildWorkspaceCloneCommand("https://forge.test/repo.git", "test-token", "main", 0, workspaceCloneSource{})
	if strings.Index(command, "smithers_runtime_ready()") > strings.Index(command, "git clone") {
		t.Fatal("runtime gate follows clone")
	}
	if strings.Index(command, "smithers_runtime_ready()") > strings.Index(command, "GIT_CONFIG") {
		t.Fatal("bootstrap gate inherits repository credential")
	}
}
