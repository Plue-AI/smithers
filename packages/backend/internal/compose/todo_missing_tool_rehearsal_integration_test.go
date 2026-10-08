package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The installed coding host executes a real exit-127 CheckCommand over its
// native immutable source. The authenticated bridge, dispatcher, verifier,
// HTTP TODO provider and mounted app are production paths. Linux substitutes
// the guest compute/file transport only; this is not machine qualification.
func TestTodoMissingToolCodingReceiptBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_TODO_MISSING_TOOL_BROWSER") != "1" {
		t.Skip("enable composed coding-check/card proof")
	}
	spa, err := filepath.Abs("../../../../apps/app/dist")
	require.NoError(t, err)
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_TODO_MISSING_TOOL_BROWSER", "C-APP-03", "missing-tool-")
	require.True(t, r.install("Install"))
	t.Log("Composed install ready")
	source, err := os.ReadFile(filepath.Join(r.root, "flows/test/fixtures/missing-tool/flows/todo/flow.ts"))
	require.NoError(t, err)
	_, err = r.pushGitHubMain("Seed the main machine recipe", map[string]string{".smithers/machine.json": `{"packages":["jq"]}`})
	require.NoError(t, err)
	activateMonitorOverride(t, r, string(source))
	t.Log("Missing-tool TODO override Active")
	n, err := r.file("Missing machine tool", "Check the machine for figlet")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(n, 3*time.Minute, "failed")
	require.NoError(t, err)
	data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", n), "", 200)
	require.NoError(t, err)
	var card struct {
		Failure struct {
			Class       string `json:"class"`
			MissingTool struct {
				Name string `json:"name"`
				File string `json:"file"`
			} `json:"missing_tool"`
		} `json:"failure"`
	}
	require.NoError(t, json.Unmarshal(data, &card))
	require.Equal(t, "user", card.Failure.Class)
	require.Equal(t, "figlet", card.Failure.MissingTool.Name)
	require.Equal(t, ".smithers/machine.json", card.Failure.MissingTool.File)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "certified-todo.json"), data, 0600))
	var commands int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='workspace.command'`).Scan(&commands))
	require.Zero(t, commands, "certification must come from the coding check, without fabricated workspace commands")
	cookies, err := json.Marshal(r.jar.Cookies(mustRehearsalURL(r.origin)))
	require.NoError(t, err)
	command := exec.CommandContext(r.ctx, "pnpm", "exec", "playwright", "test", "--config", "e2e/real/missing-tool.config.ts")
	command.Dir = filepath.Join(r.root, "apps/app")
	command.Env = append(os.Environ(), "SMITHERS_MISSING_TOOL_OUTPUT_DIR="+filepath.Join(r.evidence, "browser"), "SMITHERS_MISSING_TOOL_ORIGIN="+r.origin, "SMITHERS_MISSING_TOOL_COOKIES="+string(cookies), "SMITHERS_MISSING_TOOL_N="+strconv.FormatInt(n, 10))
	output, err := command.CombinedOutput()
	t.Log(string(output))
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "browser.log"), output, 0600))
	require.NoError(t, err)
}
