package workspaceconformance

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/workspace"
)

// RunCapacityRefusal checks admission through CreateWorkspace, not an internal
// counter. The adapter fixture supplies its typed error assertion.
func RunCapacityRefusal(t *testing.T, runtime workspace.WorkspaceRuntime, ctx context.Context, spec workspace.WorkspaceSpec, typed func(error) bool) {
	t.Helper()
	_, err := runtime.CreateWorkspace(ctx, spec)
	if err == nil {
		_ = runtime.DeleteWorkspace(ctx, spec.ID)
		t.Fatal("capacity limit admitted a new workspace")
	}
	if !typed(err) {
		t.Fatalf("capacity refusal lost its type: %T: %v", err, err)
	}
	if _, err := runtime.InspectWorkspace(ctx, spec.ID); !errors.Is(err, workspace.ErrWorkspaceNotFound) {
		t.Fatalf("capacity refusal workspace inspection = %v; want ErrWorkspaceNotFound", err)
	}
}

func runTerminal(t *testing.T, h CoreHarness) {
	t.Helper()
	ctx, cancel := context.WithTimeout(h.Context("terminal"), 20*time.Second)
	defer cancel()
	terminal, err := h.Runtime.OpenWorkspaceTerminal(ctx, h.Spec.ID, workspace.Command{Args: []string{"/bin/sh"}})
	if h.TerminalError != nil {
		if terminal != nil {
			_ = terminal.Close()
			t.Fatal("unbound terminal spawned a session")
		}
		if !errors.Is(err, h.TerminalError) {
			t.Fatalf("unbound terminal = %v; want %v", err, h.TerminalError)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	if err := terminal.Resize(ctx, 120, 40); err != nil {
		t.Fatal(err)
	}
	if _, err := terminal.Write([]byte(`printf 'terminal-%s %s\n' "$((40+2))" "$(stty size)"
exit
`)); err != nil {
		t.Fatal(err)
	}
	output := make(chan string, 1)
	go func() { data, _ := io.ReadAll(terminal); output <- string(data) }()
	select {
	case got := <-output:
		if !strings.Contains(got, "terminal-42 40 120") {
			t.Fatalf("terminal output = %q", got)
		}
	case <-ctx.Done():
		t.Fatal("terminal did not finish before deadline")
	}
}

func runHead(t *testing.T, h CoreHarness) string {
	t.Helper()
	resolver, ok := h.Runtime.(workspace.WorkspaceSourceRevisionResolver)
	if !ok {
		t.Fatal("advertised source revision has no resolver")
	}
	// A Jujutsu workspace resolves its working-copy commit, which captures the
	// tree as it is; only a plain Git checkout has a HEAD that a dirty tree refuses.
	kind, err := h.Runtime.ExecuteCommand(h.Context("head-kind"), h.Spec.ID, workspace.Command{Args: []string{"/bin/sh", "-c", "test -d .jj && printf jj || printf git"}})
	if err != nil || kind.ExitCode != 0 {
		t.Fatalf("head fixture kind: %#v, %v", kind, err)
	}
	if kind.Stdout == "jj" {
		return runJujutsuHead(t, h, resolver)
	}
	result, err := h.Runtime.ExecuteCommand(h.Context("head-fixture"), h.Spec.ID, workspace.Command{Args: []string{"/bin/sh", "-c", "git init -q && git add . && git -c user.name=Conformance -c user.email=conformance@example.invalid commit -qm fixture && git rev-parse HEAD"}})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("head fixture: %#v, %v", result, err)
	}
	head, err := resolver.ResolveWorkspaceSourceRevision(h.Context("resolve-head"), h.Spec.ID)
	if err != nil || head != strings.TrimSpace(result.Stdout) {
		t.Fatalf("captured head = %q, %v; want %q", head, err, result.Stdout)
	}
	if err := writeConformanceFile(h.Runtime, h.Context("dirty-head"), h.Spec.ID, "uncommitted", []byte("dirty"), 0644, "absent"); err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.ResolveWorkspaceSourceRevision(h.Context("refuse-dirty-head"), h.Spec.ID); !errors.Is(err, workspace.ErrWorkspaceSourceUnavailable) {
		t.Fatalf("dirty Git capture = %v", err)
	}
	if err := h.Runtime.RemoveFile(h.Context("clean-head"), h.Spec.ID, "uncommitted"); err != nil {
		t.Fatal(err)
	}
	return head
}

// runJujutsuHead checks each resolved revision against the Git tree it names:
// an uncommitted file appears in a new commit, and leaves the next one.
func runJujutsuHead(t *testing.T, h CoreHarness, resolver workspace.WorkspaceSourceRevisionResolver) string {
	t.Helper()
	capture := func(label string) (string, bool) {
		head, err := resolver.ResolveWorkspaceSourceRevision(h.Context("resolve-"+label), h.Spec.ID)
		if err != nil {
			t.Fatalf("captured %s head = %q, %v", label, head, err)
		}
		tree, err := h.Runtime.ExecuteCommand(h.Context("tree-"+label), h.Spec.ID, workspace.Command{Args: []string{"git", "ls-tree", "-r", "--name-only", head}})
		if err != nil || tree.ExitCode != 0 {
			t.Fatalf("captured %s head %q names no Git tree: %#v, %v", label, head, tree, err)
		}
		return head, strings.Contains("\n"+tree.Stdout, "\nuncommitted\n")
	}
	clean, present := capture("clean")
	if present {
		t.Fatalf("clean capture %q already holds the uncommitted file", clean)
	}
	if err := writeConformanceFile(h.Runtime, h.Context("dirty-head"), h.Spec.ID, "uncommitted", []byte("dirty"), 0644, "absent"); err != nil {
		t.Fatal(err)
	}
	dirty, present := capture("dirty")
	if dirty == clean || !present {
		t.Fatalf("dirty Jujutsu capture = %q (file present %t); want a new commit after %q holding the file", dirty, present, clean)
	}
	if err := h.Runtime.RemoveFile(h.Context("clean-head"), h.Spec.ID, "uncommitted"); err != nil {
		t.Fatal(err)
	}
	restored, present := capture("restored")
	if restored == dirty || present {
		t.Fatalf("restored Jujutsu capture = %q (file present %t); want a new commit after %q without the file", restored, present, dirty)
	}
	return restored
}

// runCompareWrites covers base_digest batch atomicity when the adapter has
// qualified the mutation boundary. Missing qualification stays visible as a
// skip rather than enabling the private candidate or substituting WriteFile.
func runCompareWrites(t *testing.T, h CoreHarness) {
	t.Helper()
	writer, ok := h.Runtime.(workspace.WorkspaceCompareWriter)
	if !ok {
		t.Skip("qualified WorkspaceCompareWriter unavailable; stale-write proof blocked")
	}
	ctx := h.Context("compare-write")
	for _, name := range []string{"compare-a", "compare-b"} {
		if err := writeConformanceFile(h.Runtime, ctx, h.Spec.ID, name, []byte("original"), 0644, "absent"); err != nil {
			t.Fatal(err)
		}
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte("original")))
	_, err := writer.CompareWriteFiles(ctx, h.Spec.ID, []workspace.FileMutation{
		{Path: "compare-a", BaseDigest: digest, Content: []byte("replacement")},
		{Path: "compare-b", BaseDigest: "absent", Content: []byte("replacement")},
	})
	var stale *workspace.StaleFileError
	if !errors.As(err, &stale) || stale.Path != "compare-b" || stale.CurrentDigest != digest {
		t.Fatalf("stale-write refusal = %#v, %v", stale, err)
	}
	for _, name := range []string{"compare-a", "compare-b"} {
		got, err := h.Runtime.ReadFile(ctx, h.Spec.ID, name)
		if err != nil || string(got) != "original" {
			t.Fatalf("refused batch changed %s: %q, %v", name, got, err)
		}
	}
	if _, err := writer.CompareWriteFiles(ctx, h.Spec.ID, []workspace.FileMutation{{Path: "compare-a", BaseDigest: digest, Content: []byte("replacement")}}); err != nil {
		t.Fatal(err)
	}
	got, err := h.Runtime.ReadFile(ctx, h.Spec.ID, "compare-a")
	if err != nil || string(got) != "replacement" {
		t.Fatalf("fresh write = %q, %v", got, err)
	}
}
