package guestfixture

import (
	"context"
	"errors"
	workspace "github.com/smithersai/smithers/packages/backend/workspace"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

type localExecutor struct {
	root  string
	calls int
	fail  bool
}

func (e *localExecutor) ExecuteCommand(ctx context.Context, _ string, c workspace.Command) (workspace.CommandResult, error) {
	e.calls++
	if e.fail {
		return workspace.CommandResult{}, errors.New("transport failed")
	}
	cmd := exec.CommandContext(ctx, c.Args[0], c.Args[1:]...)
	cmd.Dir = e.root
	out, err := cmd.CombinedOutput()
	if err != nil {
		return workspace.CommandResult{ExitCode: 1, Stderr: string(out)}, nil
	}
	return workspace.CommandResult{}, nil
}
func TestUploadThroughSession(t *testing.T) {
	for _, size := range []int{0, 3, 32768, 32769, 100000} {
		e := &localExecutor{root: t.TempDir()}
		data := make([]byte, size)
		for i := range data {
			data[i] = byte(i)
		}
		if err := WriteFile(context.Background(), e, "vm", "nested/binary", data, 0755); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(e.root, "nested/binary"))
		if err != nil || string(got) != string(data) {
			t.Fatalf("readback: %v", err)
		}
		info, _ := os.Stat(filepath.Join(e.root, "nested/binary"))
		if info.Mode().Perm() != 0755 {
			t.Fatal(info.Mode())
		}
		if e.calls != max(1, (size+32767)/32768) {
			t.Fatal(e.calls)
		}
	}
}
func TestUploadRefusesEscapeAndFailure(t *testing.T) {
	e := &localExecutor{root: t.TempDir()}
	for _, name := range []string{".", "../escape", "/tmp/escape", "nested/../escape"} {
		if WriteFile(context.Background(), e, "vm", name, nil, 0600) == nil {
			t.Fatal(name)
		}
	}
	if e.calls != 0 {
		t.Fatal("invalid path dispatched")
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(e.root, "link")); err != nil {
		t.Fatal(err)
	}
	if WriteFile(context.Background(), e, "vm", "link/escape", nil, 0600) == nil {
		t.Fatal("symlink escape")
	}
	e.fail = true
	if WriteFile(context.Background(), e, "vm", "file", nil, 0600) == nil {
		t.Fatal("transport error hidden")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	before := e.calls
	if !errors.Is(WriteFile(ctx, e, "vm", "file", nil, 0600), context.Canceled) || e.calls != before {
		t.Fatal("cancelled upload dispatched")
	}
}
