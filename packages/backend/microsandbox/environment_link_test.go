package microsandbox

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Execute the real npm against a checkout through LinkWorkspaceEnvironment's
// public boundary. Only the msb transport is a fixture; no network or VM is used.
func TestLinkWorkspaceEnvironmentDoesNotCreateTodoLockfile(t *testing.T) {
	for _, locked := range []bool{false, true} {
		name := "lockless"
		if locked {
			name = "locked"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			node, err := exec.LookPath("node")
			require.NoError(t, err)
			nodeDirJSON, _ := json.Marshal(filepath.Dir(node))
			require.NoError(t, os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"fixture","version":"1.0.0"}`), 0600))
			lock := []byte(`{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0"}}}`)
			files := map[string][]byte{"package.json": []byte(`{"name":"fixture","version":"1.0.0"}`)}
			if locked {
				require.NoError(t, os.WriteFile(filepath.Join(dir, "package-lock.json"), lock, 0600))
				files["package-lock.json"] = lock
			}
			recipe, err := DetectRecipe(func(name string) ([]byte, bool, error) { data, ok := files[name]; return data, ok, nil })
			require.NoError(t, err)
			require.Len(t, recipe.Installs, 1)
			command := append(append([]string(nil), recipe.Installs[0].Offline...), "--ignore-scripts", "--no-audit", "--no-fund")

			script := filepath.Join(dir, "fixture-msb")
			requestFile := filepath.Join(dir, "request.json")
			dirJSON, _ := json.Marshal(dir)
			requestJSON, _ := json.Marshal(requestFile)
			// npm lifecycle code still executes as this unprivileged test process.
			require.NoError(t, os.WriteFile(script, []byte("#!"+node+"\nconst fs=require('node:fs'),cp=require('node:child_process');const input=fs.readFileSync(0,'utf8');fs.writeFileSync("+string(requestJSON)+",input);const r=JSON.parse(input);const p=cp.spawnSync(r.argv[0],r.argv.slice(1),{cwd:"+string(dirJSON)+",encoding:'utf8',env:{...process.env,PATH:"+string(nodeDirJSON)+"+':'+process.env.PATH,npm_config_cache:"+string(dirJSON)+"+'/cache'}});process.stdout.write(p.stdout||'');process.stderr.write(p.stderr||'');process.stderr.write('\\0SMITHERS-EXIT '+p.status+'\\0');\n"), 0700))
			ws := newWorkspace(metadata{ID: "fixture", Machine: "fixture-machine", State: string(workspaceapi.WorkspaceRunning), Link: command}, dir)
			runtime := &Runtime{cli: &cli{binary: script, home: dir}, config: Config{CommandTimeout: 30 * time.Second, OutputLimit: 4096}, workspaces: map[string]*workspace{"fixture": ws}, semaphore: make(chan struct{}, 1)}
			require.NoError(t, runtime.LinkWorkspaceEnvironment(t.Context(), "fixture"))
			raw, err := os.ReadFile(requestFile)
			require.NoError(t, err)
			var request execRequest
			require.NoError(t, json.Unmarshal(raw, &request))
			require.Equal(t, "agent", request.User)
			if locked {
				contents, err := os.ReadFile(filepath.Join(dir, "package-lock.json"))
				require.NoError(t, err)
				require.Equal(t, lock, contents)
				require.Equal(t, command, request.Argv)
			} else {
				_, err := os.Stat(filepath.Join(dir, "package-lock.json"))
				require.True(t, os.IsNotExist(err), "machine install must not add a lockfile")
				require.Contains(t, request.Argv, "--package-lock=false")
			}
		})
	}
}

// Before the machine's successful setup receipt, even an early public read or
// host request cannot start the watcher and misattribute dependency writes.
func TestMachinedWaitsForWorkspaceEnvironmentReceipt(t *testing.T) {
	for _, ready := range []bool{false, true} {
		name := "pending"
		if ready {
			name = "prepared"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			binary := filepath.Join(dir, "fixture-msb")
			argv := filepath.Join(dir, "argv")
			response := "exit 2"
			if ready {
				response = "printf 'receipt'"
			}
			require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > "+shellQuote(argv)+"\n"+response+"\n"), 0700))
			ws := newWorkspace(metadata{ID: "fixture", Machine: "fixture-machine", State: "running", Link: []string{"npm", "install", "--offline"}}, dir)
			runtime := &Runtime{cli: &cli{binary: binary, home: dir}, workspaces: map[string]*workspace{"fixture": ws}}
			err := runtime.EnsureMachined(t.Context(), "fixture")
			require.ErrorIs(t, err, ErrUnavailable)
			if ready {
				require.Contains(t, err.Error(), "installed machine host providers unavailable")
			} else {
				require.Contains(t, err.Error(), "workspace environment is not prepared")
			}
			raw, err := os.ReadFile(argv)
			require.NoError(t, err)
			require.Contains(t, string(raw), "receipt-read\n/workspace\n.git/smithers-workspace-initialization.json")
			require.NotContains(t, string(raw), "machined-start")
			require.Nil(t, ws.daemonBoot)
		})
	}
}
