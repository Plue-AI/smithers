package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Keep real namespace execution and every optional runtime capability. Only the
// availability of its isolation guarantee changes, as on runtime loss.
type publicationIsolationRuntime struct {
	bindingProcessRuntime
	unavailable atomic.Bool
	commands    atomic.Int64
}

func (r *publicationIsolationRuntime) Isolation() workspaceapi.IsolationLevel {
	if r.unavailable.Load() {
		return workspaceapi.IsolationTrustedProcess
	}
	return r.bindingProcessRuntime.Isolation()
}

func (r *publicationIsolationRuntime) ExecuteCommand(ctx context.Context, id string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	r.commands.Add(1)
	return r.bindingProcessRuntime.ExecuteCommand(ctx, id, command)
}

// Packaged candidate/propose actions, the publication worker and the served
// diff use the composed install. This Linux rehearsal substitutes provisioning
// and model answers; real microVM/root containment remains reference-host proof.
func TestMythicalPRShapeHostileProductionDispatch(t *testing.T) {
	t.Setenv("REHEARSAL_PUBLIC_REPOSITORY", "1")
	r := newRehearsal(t, "SMITHERS_GH03_REHEARSAL", "C-J10-01-hostile", "hostile-pr-")
	runtime, ok := r.workspaceRuntime.(bindingProcessRuntime)
	require.True(t, ok, "hostile acceptance requires the namespace runtime")
	availability := &publicationIsolationRuntime{bindingProcessRuntime: runtime}
	r.options.Workspace = availability
	// A pre-claim restart rotates the setup token. Consume only this boot's
	// printed line when walking setup, keeping the previous boot's output apart.
	r.stdout = &lockedBuffer{}
	r.restartBackend()
	require.True(t, r.install("Install ready"))
	// Retain failed production dispatch responses alongside the host canaries.
	production := r.serving.Load()
	observedRouter := http.Handler(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !strings.Contains(request.URL.Path, "/stack/") {
			(*production).ServeHTTP(w, request)
			return
		}
		receipt := httptest.NewRecorder()
		(*production).ServeHTTP(receipt, request)
		if receipt.Code >= 400 {
			t.Logf("reserved dispatch %s: %d %s", request.URL.Path, receipt.Code, receipt.Body.String())
		}
		for key, values := range receipt.Header() {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(receipt.Code)
		_, _ = w.Write(receipt.Body.Bytes())
	}))
	r.serving.Store(&observedRouter)

	store := filepath.Join(r.repositoryRoot, "rehearsal-owner", "app", ".jj", "repo", "store", "git")
	require.DirExists(t, store)
	programs := t.TempDir()
	markers := map[string]string{}
	program := func(name string) string {
		marker := filepath.Join(programs, name+".executed")
		path := filepath.Join(programs, name)
		require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\ntouch \"${SMITHERS_CANARY_PATH:-"+marker+"}\"\nexit 1\n"), 0700))
		markers[name] = marker
		return path
	}
	git := func(args ...string) {
		cmd := exec.CommandContext(r.ctx, "git", append([]string{"--git-dir", store}, args...)...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	hooks := filepath.Join(programs, "hooks")
	require.NoError(t, os.Mkdir(hooks, 0700))
	for _, name := range []string{"pre-push", "pre-receive", "post-receive", "reference-transaction", "post-checkout", "pre-commit", "post-commit", "pre-merge-commit"} {
		path := program(name)
		bytes, err := os.ReadFile(path)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(hooks, name), bytes, 0700))
	}
	git("config", "core.hooksPath", hooks)
	for _, entry := range []struct{ key, name string }{
		{"diff.external", "external-diff"}, {"diff.hostile.command", "diff-driver"},
		{"diff.hostile.textconv", "textconv"}, {"merge.hostile.driver", "merge-driver"},
		{"credential.helper", "credential-helper"}, {"core.fsmonitor", "fsmonitor"},
		{"core.alternateRefsCommand", "alternate-refs"}, {"filter.hostile.clean", "clean-filter"},
	} {
		path := program(entry.name)
		if entry.key == "credential.helper" {
			path = "!" + path
		}
		git("config", entry.key, path)
	}
	git("config", "merge.renormalize", "true")
	require.NoError(t, os.WriteFile(filepath.Join(store, "info", "attributes"), []byte("*.md diff=hostile merge=hostile filter=hostile\n"), 0600))
	first, err := r.file("Earlier change", "[PR] [FILE earlier.md] Add a note to earlier.md.")
	require.NoError(t, err)
	firstCard, err := r.waitTodoWithin(first, 3*time.Minute, "in_review")
	require.NoError(t, err)
	second, err := r.file("Safe transfer", "[PR] [FILE safe.md] Add a note to safe.md.")
	require.NoError(t, err)
	card, err := r.waitTodoWithin(second, 3*time.Minute, "in_review")
	require.NoError(t, err)
	pull, err := r.checkPull(card.PR.Number, card.PR.Head)
	require.NoError(t, err)
	require.Equal(t, "Safe transfer", pull.Title)
	require.Equal(t, "smithers/safe-transfer", pull.Head.Ref)
	require.Equal(t, "main", pull.Base.Ref)
	require.False(t, firstCard.PR.Draft)
	require.True(t, pull.Draft)
	require.Contains(t, pull.Body, "Add a note to safe.md.")
	require.Contains(t, pull.Body, fmt.Sprintf("[T%d]", first))
	require.Contains(t, pull.Body, "Requested by @rehearsal-owner")
	var base, candidate string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT candidate_base,candidate_head FROM mythical_items WHERE number=$1`, second).Scan(&base, &candidate))
	baseBytes, err := hostexec.Git(r.ctx, "--git-dir", store, "rev-parse", base+"^{tree}").CombinedOutput()
	baseTree := strings.TrimSpace(string(baseBytes))
	require.NoError(t, err)
	firstTree, err := r.githubGit("rev-parse", firstCard.PR.Head+"^{tree}")
	require.NoError(t, err)
	require.Equal(t, firstTree, baseTree)
	candidateBytes, err := hostexec.Git(r.ctx, "--git-dir", store, "rev-parse", candidate+"^{tree}").CombinedOutput()
	require.NoError(t, err)
	publishedTree, err := r.githubGit("rev-parse", pull.Head.SHA+"^{tree}")
	require.NoError(t, err)
	require.Equal(t, strings.TrimSpace(string(candidateBytes)), publishedTree)
	parents, err := r.githubGit("rev-list", "--parents", "-n", "1", pull.Head.SHA)
	require.NoError(t, err)
	require.Equal(t, []string{pull.Head.SHA, r.mainCommit}, strings.Fields(parents))
	paths, err := r.githubGit("ls-tree", "--name-only", pull.Head.SHA)
	require.NoError(t, err)
	require.Contains(t, strings.Split(paths, "\n"), "earlier.md")
	require.Contains(t, strings.Split(paths, "\n"), "safe.md")
	data, err := r.expect("GET", "/api/branches/"+url.PathEscape(pull.Head.Ref)+"/diff", "", 200)
	require.NoError(t, err)
	var diff struct {
		Files []struct {
			Path    string
			Against struct{ Kind, Rev string }
			Hunks   []struct{ Lines []struct{ Op, Text string } }
		}
	}
	require.NoError(t, json.Unmarshal(data, &diff))
	require.Len(t, diff.Files, 1)
	require.Equal(t, "safe.md", diff.Files[0].Path)
	require.Equal(t, "item_base", diff.Files[0].Against.Kind)
	require.Equal(t, base, diff.Files[0].Against.Rev)
	require.Equal(t, "+", diff.Files[0].Hunks[0].Lines[0].Op)
	require.Equal(t, "Hello from Smithers!", diff.Files[0].Hunks[0].Lines[0].Text)
	// Receipts prove this was the packaged dispatch, not a seeded accepted item.
	var receiptSummary string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT COALESCE(string_agg(operation || ':' || COALESCE(payload->>'n','missing'),','),'') FROM product_job_requests WHERE operation LIKE 'stack.%'`).Scan(&receiptSummary))
	t.Logf("reserved operation receipts: %s", receiptSummary)
	for _, number := range []int64{first, second} {
		var candidateReceipts, proposalReceipts int
		require.Eventually(t, func() bool {
			err := r.pool.QueryRow(r.ctx, `SELECT count(*) FILTER(WHERE operation='stack.candidate.completed'),count(*) FILTER(WHERE operation='stack.propose.completed') FROM product_job_requests WHERE payload->>'n'=($1::bigint)::text`, number).Scan(&candidateReceipts, &proposalReceipts)
			return err == nil && candidateReceipts > 0 && proposalReceipts > 0
		}, time.Minute, 100*time.Millisecond, "T%d packaged operations must commit both receipts (candidate=%d proposal=%d)", number, candidateReceipts, proposalReceipts)
	}
	// Positive execution control uses the selected machine boundary. It does not
	// certify Linux rehearsal provisioning as a real microVM.
	var workspace string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT workspace_id FROM mythical_items WHERE number=$1`, second).Scan(&workspace))
	observed, err := r.workspaceRuntime.InspectWorkspace(r.ctx, workspace)
	require.NoError(t, err)
	identity, err := r.workspaceRuntime.ExecuteCommand(r.ctx, workspace, workspaceapi.Command{Args: []string{"id", "-u"}})
	require.NoError(t, err)
	require.Zero(t, identity.ExitCode, identity.Stderr)
	require.Equal(t, "19998\n", identity.Stdout)
	secret := filepath.Join(programs, "host-secret")
	require.NoError(t, os.WriteFile(secret, []byte("host-only-canary"), 0600))
	read, err := r.workspaceRuntime.ExecuteCommand(r.ctx, workspace, workspaceapi.Command{Args: []string{"cat", secret}})
	require.NoError(t, err)
	require.NotZero(t, read.ExitCode)
	require.NotContains(t, read.Stdout, "host-only-canary")
	for name := range markers {
		guestProgram := filepath.Join(observed.Home, ".smithers-canary-program-"+name)
		bytes, err := os.ReadFile(filepath.Join(programs, name))
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(guestProgram, bytes, 0700))
		positive := filepath.Join(observed.Home, ".smithers-machine-canary-"+name)
		result, err := r.workspaceRuntime.ExecuteCommand(r.ctx, workspace, workspaceapi.Command{Args: []string{guestProgram}, Environment: map[string]string{"SMITHERS_CANARY_PATH": positive}})
		require.NoError(t, err)
		require.Equal(t, 1, result.ExitCode, result.Stderr)
		result, err = r.workspaceRuntime.ExecuteCommand(r.ctx, workspace, workspaceapi.Command{Args: []string{"test", "-f", positive}})
		require.NoError(t, err)
		require.Zero(t, result.ExitCode, "%s positive control: %s", name, result.Stderr)
		_, err = r.workspaceRuntime.ExecuteCommand(r.ctx, workspace, workspaceapi.Command{Args: []string{"rm", positive, guestProgram}})
		require.NoError(t, err)
	}
	for name, marker := range markers {
		require.NoFileExists(t, marker, "%s executed on host", name)
	}
	// Refuse both packaged operation endpoints on this very same composed
	// install, with its real live-run credential and accepted generation.
	token, ok := r.hostCredentials.Load(workspace)
	require.True(t, ok)
	var generation int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT generation FROM mythical_items WHERE number=$1`, second).Scan(&generation))
	var before int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation LIKE 'stack.%'`).Scan(&before))
	commands := availability.commands.Load()
	availability.unavailable.Store(true)
	preflight := fmt.Sprintf(`{"requestId":%q}`, uuid.NewString())
	call := func(operation, body string, status int) {
		t.Helper()
		request, err := http.NewRequestWithContext(r.ctx, "POST", r.origin+"/api/repos/rehearsal-owner/app/workspaces/"+workspace+"/stack/"+operation, strings.NewReader(body))
		require.NoError(t, err)
		request.Header.Set("Authorization", "Bearer "+token.(string))
		request.Header.Set("Content-Type", "application/json")
		response, err := r.client.Do(request)
		require.NoError(t, err)
		require.Equal(t, status, response.StatusCode, operation)
		if status == http.StatusServiceUnavailable {
			var refusal struct{ Code, Class, Message string }
			require.NoError(t, json.NewDecoder(response.Body).Decode(&refusal))
			require.Equal(t, "service_unavailable", refusal.Code)
			require.Equal(t, "infra", refusal.Class)
			require.Equal(t, "service unavailable", refusal.Message)
		}
		require.NoError(t, response.Body.Close())
	}
	call("candidate", preflight, http.StatusServiceUnavailable)
	// Syntactically valid but absent objects must not reach the source reader
	// while containment is unavailable. Preflight alone would not prove this.
	call("candidate", fmt.Sprintf(`{"requestId":%q,"source":{"change_id":"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk","commit_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","tree_id":"cccccccccccccccccccccccccccccccccccccccc","parent_commit_ids":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}}`, uuid.NewString()), http.StatusServiceUnavailable)
	call("propose", fmt.Sprintf(`{"requestId":%q,"generation":%d}`, uuid.NewString(), generation), http.StatusServiceUnavailable)
	availability.unavailable.Store(false)
	// Retry the exact refused request after the same runtime regains isolation.
	call("candidate", preflight, http.StatusNoContent)
	require.Equal(t, commands, availability.commands.Load(), "refusal must precede source observation or host fallback")
	var after int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation LIKE 'stack.%'`).Scan(&after))
	require.Equal(t, before, after, "refused operations create no dispatch receipt")
	for name, marker := range markers {
		require.NoFileExists(t, marker, "%s executed on host during isolation loss", name)
	}
	githubLifecycleBrowserPhase(t, r, second, "shape")
}
