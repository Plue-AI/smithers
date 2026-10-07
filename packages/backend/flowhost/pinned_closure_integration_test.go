//go:build unix

package flowhost

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// This is process-runtime component evidence, not C-SEC-02 or production
// admission qualification. The materialized roots stand in for the native
// pinned-commit export; the registry, snapshot store and interpreter are real.
func TestPinnedClosureProcessRestartIgnoresEditableBranch(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	root, err := filepath.Abs("../../..")
	require.NoError(t, err)
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	runtime, err := process.New(process.Config{Root: t.TempDir(), Environment: map[string]string{"PATH": os.Getenv("PATH")}})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	box, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: uuid.NewString()})
	require.NoError(t, err)
	box, err = runtime.StartWorkspace(ctx, box.ID)
	require.NoError(t, err)
	write := func(name, value string) {
		t.Helper()
		require.NoError(t, os.MkdirAll(filepath.Dir(name), 0700))
		require.NoError(t, os.WriteFile(name, []byte(value), 0600))
	}
	flow := `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { value } from "../../lib/value.ts"
export default Flow.make("todo", { description: "Pinned fixture", payload: {}, success: Schema.String,
body: Node.capture({}, () => Node.succeed(value)) })`
	makeSource := func(version string) string {
		source := filepath.Join(t.TempDir(), version)
		write(filepath.Join(source, "flows/todo/flow.ts"), flow)
		write(filepath.Join(source, "lib/value.ts"), "export const value = "+`"`+version+`"`)
		write(filepath.Join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
		require.NoError(t, os.Symlink(filepath.Join(root, "flows/node_modules"), filepath.Join(source, "node_modules")))
		return source
	}
	v1, v2 := makeSource("approved-v1"), makeSource("approved-v2")
	type receipt struct {
		Digest string `json:"digest"`
		Output string `json:"output"`
	}
	run := func(source, digest string, refusal string) receipt {
		t.Helper()
		args := []string{node, "--experimental-strip-types", filepath.Join(root, "flows/test/fixtures/pinned-closure-entry.ts"), source}
		if digest != "" {
			args = append(args, digest)
		}
		result, err := runtime.ExecuteCommand(ctx, box.ID, workspaceapi.Command{Args: args})
		require.NoError(t, err)
		if refusal != "" {
			require.NotZero(t, result.ExitCode, result.Stdout)
			require.Contains(t, result.Stderr, refusal)
			return receipt{}
		}
		require.Zero(t, result.ExitCode, result.Stderr)
		var got receipt
		require.NoError(t, json.Unmarshal([]byte(result.Stdout), &got), result.Stdout)
		return got
	}
	// The same real interpreter can run working-copy code only through the
	// explicitly authorized draft registry; it is separate from either pin.
	write(filepath.Join(box.Root, "flows/todo/flow.ts"), flow)
	write(filepath.Join(box.Root, "lib/value.ts"), `export const value = "draft-working-copy"`)
	write(filepath.Join(box.Root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
	require.NoError(t, os.Symlink(filepath.Join(root, "flows/node_modules"), filepath.Join(box.Root, "node_modules")))
	require.Equal(t, "draft-working-copy", run(box.Root, "draft", "").Output)
	first := run(v1, "", "")
	require.Equal(t, "approved-v1", first.Output)
	require.Len(t, first.Digest, 64)
	active := run(v2, "", "")
	require.Equal(t, "approved-v2", active.Output)
	require.NotEqual(t, first.Digest, active.Digest)
	marker := filepath.Join(box.Root, "branch-imported")
	canary := "import { writeFileSync } from 'node:fs'; writeFileSync(" + `"` + marker + `"` + ", 'imported'); throw new Error('branch imported')"
	write(filepath.Join(box.Root, "flows/todo/flow.ts"), canary)
	write(filepath.Join(box.Root, "lib/value.ts"), canary)
	write(filepath.Join(box.Root, "pnpm-lock.yaml"), "edited branch lockfile")
	// Each execution starts a new OS process: no module cache can supply v1.
	for range 2 {
		require.Equal(t, first, run(v1, first.Digest, ""))
	}
	require.Equal(t, active, run(v2, active.Digest, ""))
	run(v2, first.Digest, "execution_changed")
	run(filepath.Join(t.TempDir(), "missing"), first.Digest, "root_missing")
	index := filepath.Join(v1, ".flows/executions", first.Digest+".json")
	retainedIndex, err := os.ReadFile(index)
	require.NoError(t, err)
	write(index, `"`+strings.Repeat("0", 64)+`"`)
	run(v1, first.Digest, "missing")
	write(index, string(retainedIndex))
	write(filepath.Join(v2, "lib/value.ts"), canary)
	run(v2, active.Digest, "execution_changed")
	_, err = os.Stat(marker)
	require.True(t, os.IsNotExist(err), "editable source was imported: %v", err)
	// Corruption of the actual immutable dependency state must still refuse.
	write(filepath.Join(v1, "pnpm-lock.yaml"), "corrupt pinned lockfile")
	run(v1, first.Digest, "execution_changed")
}
