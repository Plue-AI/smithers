package microsandbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestMissingToolErrorKnownExecutables(t *testing.T) {
	for _, fixture := range []struct{ tool, file string }{
		{"node", ".node-version"}, {"pnpm", "package.json"}, {"npm", "package.json"}, {"yarn", "package.json"}, {"bun", "package.json"},
		{"go", "go.mod"}, {"cargo", "rust-toolchain.toml"}, {"python", ".python-version"}, {"uv", "pyproject.toml"},
	} {
		t.Run(fixture.tool, func(t *testing.T) {
			err := MissingToolError(workspaceapi.Command{Args: []string{fixture.tool, "--version"}}, workspaceapi.CommandResult{ExitCode: 127})
			requireRecipeRefusal(t, err, fixture.file)
			var refusal *RecipeError
			if !errors.As(err, &refusal) || !strings.Contains(refusal.Message, fixture.tool) {
				t.Fatalf("missing-tool refusal fails to name %q: %v", fixture.tool, err)
			}
		})
	}
}

func TestMissingToolErrorShellCommandsUseFailureEvidence(t *testing.T) {
	for _, fixture := range []struct{ shell, command, stderr, tool, file string }{
		{"sh", "cargo test", "sh: 1: cargo: not found\n", "cargo", "rust-toolchain.toml"},
		{"bash", "node --version && pnpm test", "bash: line 1: pnpm: command not found\n", "pnpm", "package.json"},
		{"sh", "uv sync", "/bin/sh: uv: not found\n", "uv", "pyproject.toml"},
		{"bash", "go test ./...", "bash: go: command not found\n", "go", "go.mod"},
	} {
		t.Run(fixture.shell+"/"+fixture.tool, func(t *testing.T) {
			err := MissingToolError(workspaceapi.Command{Args: []string{fixture.shell, "-c", fixture.command}}, workspaceapi.CommandResult{ExitCode: 127, Stderr: fixture.stderr})
			requireRecipeRefusal(t, err, fixture.file)
			if !strings.Contains(err.Error(), fixture.tool) {
				t.Fatalf("error names wrong failed executable: %v", err)
			}
		})
	}
}

func TestMissingToolErrorDoesNotMislabelOrdinaryFailures(t *testing.T) {
	for _, fixture := range []struct {
		args   []string
		result workspaceapi.CommandResult
	}{
		{[]string{"cargo", "test"}, workspaceapi.CommandResult{ExitCode: 1, Stderr: "compile error"}},
		{[]string{"node", "--version"}, workspaceapi.CommandResult{ExitCode: 0}},
		{[]string{"custom-build"}, workspaceapi.CommandResult{ExitCode: 127, Stderr: "custom-build: command not found"}},
		{[]string{"sh", "-c", "cargo test"}, workspaceapi.CommandResult{ExitCode: 127, Stderr: "test assertion exited 127"}},
		{[]string{"sh", "-c", "echo 'cargo: not found'"}, workspaceapi.CommandResult{ExitCode: 127, Stdout: "cargo: not found"}},
		{nil, workspaceapi.CommandResult{ExitCode: 127}},
		{[]string{"cargo;$(id)"}, workspaceapi.CommandResult{ExitCode: 127}},
		{[]string{"sh", "-c", "echo 'cargo;$(id)'"}, workspaceapi.CommandResult{ExitCode: 127, Stderr: "sh: cargo;$(id): not found"}},
	} {
		if err := MissingToolError(workspaceapi.Command{Args: fixture.args}, fixture.result); err != nil {
			t.Errorf("ordinary failure mislabeled as missing tool: args=%#v result=%#v error=%v", fixture.args, fixture.result, err)
		}
	}
}

func TestMissingToolErrorIgnoresRubyExecutables(t *testing.T) {
	for _, tool := range []string{"ruby", "bundle"} {
		for _, args := range [][]string{{tool, "--version"}, {"sh", "-c", tool + " --version"}} {
			result := workspaceapi.CommandResult{ExitCode: 127, Stderr: "sh: " + tool + ": not found\n"}
			if err := MissingToolError(workspaceapi.Command{Args: args}, result); err != nil {
				t.Errorf("unsupported tool %s gets detector instruction: %v", tool, err)
			}
		}
	}
}

// This unit test replaces the VM transport with a real executable returning
// the guest's protocol. It proves the public runner applies the mapping while
// preserving the result; real-VM dependency installation has separate tests.
func TestExecuteCommandMapsMissingToolsAndPreservesExitEvidence(t *testing.T) {
	for _, fixture := range []struct {
		name         string
		args         []string
		code         int
		stderr, file string
	}{
		{"direct missing cargo", []string{"cargo", "test"}, 127, "cargo: not found\n", "rust-toolchain.toml"},
		{"shell missing pnpm", []string{"bash", "-c", "node --version && pnpm test"}, 127, "bash: line 1: pnpm: command not found\n", "package.json"},
		{"ordinary cargo failure", []string{"cargo", "test"}, 1, "compile error\n", ""},
		{"unrelated missing tool", []string{"custom-build"}, 127, "custom-build: not found\n", ""},
		{"shell internal exit127", []string{"sh", "-c", "cargo test"}, 127, "assertion failed\n", ""},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			dir := t.TempDir()
			binary, requestFile := filepath.Join(dir, "fixture-msb"), filepath.Join(dir, "request.json")
			script := fmt.Sprintf("#!/bin/sh\ncat > %s\nprintf '%%s' 'retained stdout'\nprintf '%%s' %s >&2\nprintf '\\000SMITHERS-EXIT %d\\000' >&2\n", shellQuote(requestFile), shellQuote(fixture.stderr), fixture.code)
			if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			ws := newWorkspace(metadata{ID: "fixture", Machine: "fixture-machine", State: string(workspaceapi.WorkspaceRunning)}, dir)
			runtime := &Runtime{cli: &cli{binary: binary, home: dir}, config: Config{CommandTimeout: time.Second * 5, OutputLimit: 4096}, workspaces: map[string]*workspace{"fixture": ws}, semaphore: make(chan struct{}, 1)}
			result, err := runtime.ExecuteCommand(t.Context(), "fixture", workspaceapi.Command{Args: fixture.args})
			if fixture.file != "" {
				requireRecipeRefusal(t, err, fixture.file)
			} else if err != nil {
				t.Fatal(err)
			}
			if result.ExitCode != fixture.code || result.Stderr != fixture.stderr || result.Stdout != "retained stdout" || result.OutputTruncated {
				t.Fatalf("runner loses process evidence: %#v", result)
			}
			data, readErr := os.ReadFile(requestFile)
			if readErr != nil {
				t.Fatal(readErr)
			}
			var request execRequest
			if err := json.Unmarshal(data, &request); err != nil {
				t.Fatal(err)
			}
			if request.User != "agent" || !reflect.DeepEqual(request.Argv, fixture.args) {
				t.Fatalf("runner changed user or command: %#v", request)
			}
			if len(runtime.semaphore) != 0 {
				t.Fatal("failed command retains concurrency slot")
			}
		})
	}
}
