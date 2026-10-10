package compose

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The override runs production CheckCommand against real immutable exports.
// Native journal observation, detector, archive, authenticated topics and the
// app all belong to the full install; no monitor or TODO response is replaced.
func TestJ11ThrashBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_J11_THRASH_BROWSER") != "1" {
		t.Skip("enable native monitor browser qualification")
	}
	spa, err := filepath.Abs("../../../../apps/app/dist")
	require.NoError(t, err)
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	t.Setenv("SMITHERS_J11_THRASH_BROWSER", "1")
	r := newRehearsal(t, "SMITHERS_J11_THRASH_BROWSER", "C-J11-04", "j11-thrash-")
	require.True(t, r.install("Install"))
	source, err := os.ReadFile(filepath.Join(r.root, "flows/test/fixtures/rehearsal-monitor-todo-source.ts"))
	require.NoError(t, err)
	activateMonitorOverride(t, r, string(source))
	first, err := r.file("Thrashing checks", "[FILE thrash.md] Add a greeting to thrash.md")
	require.NoError(t, err)
	firstCard, err := r.waitTodoWithin(first, 8*time.Minute, "in_review")
	require.NoError(t, err)
	require.NotNil(t, firstCard.Run)
	waitMonitorMergeReady(t, r, first)
	require.NoError(t, r.merge(first, firstCard.PR.Head))
	require.NoError(t, r.waitMerged(first, firstCard.PR.Number, firstCard.PR.Head))
	waitMonitorRootSettlement(t, r, firstCard.Run.ID)
	request, err := http.NewRequestWithContext(r.ctx, "GET", r.origin+"/api/runs/"+url.PathEscape(firstCard.Branch.ID+":"+firstCard.Run.ID)+"/trace", nil)
	require.NoError(t, err)
	client := &http.Client{Jar: r.jar, Timeout: 45 * time.Second}
	response, err := client.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	native, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	code := response.StatusCode
	require.NoError(t, err)
	require.Equal(t, 200, code, string(native))
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "native-thrash.json"), native, 0600))
	require.Contains(t, string(native), "TestRetryBackoff", "the probe must execute in the native host")
	second, err := r.file("Cleared checks", "[CLEAR] [FILE clear.md] Add a greeting to clear.md")
	require.NoError(t, err)
	secondCard, err := r.waitTodoWithin(second, 8*time.Minute, "in_review")
	require.NoError(t, err)
	require.NotNil(t, secondCard.Run)
	waitMonitorMergeReady(t, r, second)
	require.NoError(t, r.merge(second, secondCard.PR.Head))
	require.NoError(t, r.waitMerged(second, secondCard.PR.Number, secondCard.PR.Head))
	waitMonitorRootSettlement(t, r, secondCard.Run.ID)
	// An actual coding/edit-atom between failures resets the named file.
	edited, err := r.file("Edited checks", "[EDIT] [FILE retry.go] Add a greeting to retry.go")
	require.NoError(t, err)
	editedCard, err := r.waitTodoWithin(edited, 8*time.Minute, "in_review")
	require.NoError(t, err)
	waitMonitorMergeReady(t, r, edited)
	require.NoError(t, r.merge(edited, editedCard.PR.Head))
	require.NoError(t, r.waitMerged(edited, editedCard.PR.Number, editedCard.PR.Head))
	waitMonitorRootSettlement(t, r, editedCard.Run.ID)

	// Two native failures followed by one in Retry must stay separate.
	split, err := r.file("Split checks", "[SPLIT] [FILE split.md] Add a greeting to split.md")
	require.NoError(t, err)
	splitFirst, err := r.waitTodoWithin(split, 8*time.Minute, "failed")
	require.NoError(t, err)
	_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", split), `{"op":"retry","steer":"[SINGLE] Record one failure"}`, 202)
	require.NoError(t, err)
	waitMonitorAttempt(t, r, split, 2)
	splitCard, err := r.waitTodoWithin(split, 8*time.Minute, "failed")
	require.NoError(t, err)
	require.NotEqual(t, splitFirst.Run.ID, splitCard.Run.ID)
	unflagged, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", split), "", 200)
	require.NoError(t, err)
	require.NotContains(t, string(unflagged), "Thrashing")
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "split-before-drop.json"), unflagged, 0600))
	code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", split), `{"op":"drop"}`, "monitor-drop-split")
	require.Equal(t, 202, code, string(data))
	require.NoError(t, err)
	_, err = r.waitTodoWithin(split, time.Minute, "dropped")
	require.NoError(t, err)

	// A passing check on the same TODO clears its recorded indicator.
	passing, err := r.file("Passing retry", "[STOP] [FILE passing.md] Add a greeting to passing.md")
	require.NoError(t, err)
	passingFirst, err := r.waitTodoWithin(passing, 8*time.Minute, "failed")
	require.NoError(t, err)
	flagged, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", passing), "", 200)
	require.NoError(t, err)
	require.Contains(t, string(flagged), "Thrashing: TestRetryBackoff failed 3×")
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "same-todo-flagged.json"), flagged, 0600))
	runJ11MonitorBrowser(t, r, "C-J11-04: native unchanged", []string{
		"SMITHERS_J11_THRASH_N=" + strconv.FormatInt(passing, 10), "SMITHERS_J11_CLEAR_N=" + strconv.FormatInt(second, 10),
		"SMITHERS_J11_THRASH_RUN=" + passingFirst.Branch.ID + ":" + passingFirst.Run.ID, "SMITHERS_J11_CLEAR_RUN=" + secondCard.Branch.ID + ":" + secondCard.Run.ID,
	})
	_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", passing), `{"op":"retry","steer":"[CLEAR] Pass the check"}`, 202)
	require.NoError(t, err)
	waitMonitorAttempt(t, r, passing, 2)
	passingCard, err := r.waitTodoWithin(passing, 8*time.Minute, "in_review")
	require.NoError(t, err)
	waitMonitorMergeReady(t, r, passing)
	require.NoError(t, r.merge(passing, passingCard.PR.Head))
	require.NoError(t, r.waitMerged(passing, passingCard.PR.Number, passingCard.PR.Head))
	waitMonitorRootSettlement(t, r, passingCard.Run.ID)
	runJ11MonitorBrowser(t, r, "native edit and attempt", []string{"SMITHERS_J11_THRASH_N=" + strconv.FormatInt(first, 10), "SMITHERS_J11_CLEAR_N=" + strconv.FormatInt(second, 10), "SMITHERS_J11_THRASH_RUN=" + firstCard.Branch.ID + ":" + firstCard.Run.ID, "SMITHERS_J11_CLEAR_RUN=" + secondCard.Branch.ID + ":" + secondCard.Run.ID, "SMITHERS_J11_EDIT_N=" + strconv.FormatInt(edited, 10), "SMITHERS_J11_EDIT_RUN=" + editedCard.Branch.ID + ":" + editedCard.Run.ID, "SMITHERS_J11_SPLIT_N=" + strconv.FormatInt(split, 10), "SMITHERS_J11_SPLIT_RUN=" + splitCard.Branch.ID + ":" + splitCard.Run.ID, "SMITHERS_J11_PASS_N=" + strconv.FormatInt(passing, 10), "SMITHERS_J11_PASS_RUN=" + passingCard.Branch.ID + ":" + passingCard.Run.ID, "SMITHERS_J11_PASS_PREVIOUS_RUN=" + passingFirst.Branch.ID + ":" + passingFirst.Run.ID})
}

func waitMonitorAttempt(t *testing.T, r *rehearsal, n int64, attempt int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		card, err := r.todo(n)
		if err == nil && card.Run != nil && card.Run.Attempt == attempt {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("TODO T%d did not launch attempt %d", n, attempt)
}

func runJ11MonitorBrowser(t *testing.T, r *rehearsal, grep string, env []string, specs ...string) {
	t.Helper()
	cookies, err := json.Marshal(r.jar.Cookies(mustRehearsalURL(r.origin)))
	require.NoError(t, err)
	spec := "C-J11-04.spec.ts"
	if len(specs) > 0 {
		spec = specs[0]
	}
	command := exec.CommandContext(r.ctx, "pnpm", "exec", "playwright", "test", "--config", "e2e/real/j11.config.ts", spec, "--grep", grep)
	command.Dir = filepath.Join(r.root, "apps/app")
	command.Env = append(os.Environ(), "SMITHERS_J11_OUTPUT_DIR="+filepath.Join(r.evidence, "browser-"+strings.ReplaceAll(grep, " ", "_")), "SMITHERS_J11_ORIGIN="+r.origin, "SMITHERS_J11_COOKIES="+string(cookies))
	command.Env = append(command.Env, env...)
	output, err := command.CombinedOutput()
	t.Log(string(output))
	_ = os.WriteFile(filepath.Join(r.evidence, "browser-"+strings.ReplaceAll(grep, " ", "_")+".log"), output, 0600)
	require.NoError(t, err)
}
