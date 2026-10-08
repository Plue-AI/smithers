package compose

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The actual CLI transport keeps concurrent A/B resolutions alive across the
// composed terminal close. HTTP/SQL/auth are real; guest filesystem and PTY
// remain CI doubles, so this is not native qualification.
func startTerminalClientCacheProbe(t *testing.T, ctx context.Context, origin, tokenA, tokenB string, rotateB func() string) func() {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	t.Cleanup(cancel)
	target, err := url.Parse(origin)
	require.NoError(t, err)
	proxy := httputil.NewSingleHostReverseProxy(target)
	var mutations atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			mutations.Add(1)
		}
		r.Host = target.Host
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	home := t.TempDir()
	pathA, pathB := filepath.Join(home, "A"), filepath.Join(home, "B")
	require.NoError(t, os.WriteFile(pathA, []byte(tokenA), 0600))
	require.NoError(t, os.WriteFile(pathB, []byte(tokenB), 0600))
	auth, err := json.Marshal(map[string]string{"api_url": server.URL, "token": tokenB})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(home, "auth.json"), auth, 0600))
	client, err := filepath.Abs("../../../smithers/src/internal/backend/Client.ts")
	require.NoError(t, err)
	literal := func(value string) string {
		data, err := json.Marshal(value)
		require.NoError(t, err)
		return string(data)
	}
	script := `import assert from "node:assert/strict";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Client } from ` + literal(client) + `;
const pathA=` + literal(pathA) + `, pathB=` + literal(pathB) + `, foreign=` + literal(filepath.Join(home, "foreign")) + `;
const environment={HOME:` + literal(home) + `,XDG_CONFIG_HOME:` + literal(home) + `,SMITHERS_AUTH_FILE:` + literal(filepath.Join(home, "auth.json")) + `,SMITHERS_DISABLE_SYSTEM_KEYRING:"1",SMITHERS_URL:` + literal(server.URL) + `};
const a=new Client({environment:{...environment,SMITHERS_TOKEN_FILE:pathA}});
const b=new Client({environment:{...environment,SMITHERS_TOKEN_FILE:pathB}});
await Promise.all([a.response("GET","/api/user"),b.response("GET","/api/user")]);
const lines=createInterface({input:process.stdin});
console.log("cache-ready");
await new Promise(resolve=>lines.once("line",resolve));
await assert.rejects(b.response("GET","/api/user"),error=>error.status===401);
assert.equal((await b.response("GET","/api/user")).status,200);
const identityB=b.session.credentialIdentity(environment.SMITHERS_URL);
// B's unusable replacement detects accidental cross-file cache eviction.
await writeFile(pathB,"unusable-B-replacement");
console.log("cache-rotated");
await new Promise(resolve=>lines.once("line",resolve));
await assert.rejects(a.response("POST","/api/todos",{title:"Never replay",prompt:"Never replay",place:{mode:"append"}}),error=>error.status===401);
assert.equal(b.session.credentialIdentity(environment.SMITHERS_URL),identityB);
assert.equal((await b.response("GET","/api/user")).status,200);
await rm(pathA);
await assert.rejects(a.response("POST","/api/todos",{}),error=>error.code==="token_file_unavailable");
await writeFile(pathA,"unreadable-A"); await chmod(pathA,0);
await assert.rejects(a.response("POST","/api/todos",{}),error=>error.code==="token_file_unavailable");
await chmod(pathA,0o600); await rm(pathA); await symlink(foreign,pathA);
await assert.rejects(a.response("POST","/api/todos",{}),error=>error.code==="token_file_unavailable");
assert.equal((await b.response("GET","/api/user")).status,200);
console.log("cache-qualified"); lines.close();
`
	entry := filepath.Join(home, "probe.ts")
	require.NoError(t, os.WriteFile(entry, []byte(script), 0600))
	command := exec.CommandContext(ctx, "bun", entry)
	input, err := command.StdinPipe()
	require.NoError(t, err)
	output, err := command.StdoutPipe()
	require.NoError(t, err)
	var errors bytes.Buffer
	command.Stderr = &errors
	require.NoError(t, command.Start())
	t.Cleanup(func() {
		_ = input.Close()
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() {
		require.NoError(t, command.Wait(), errors.String())
		t.Fatal("cache probe exited without concurrent resolutions")
	}
	require.Equal(t, "cache-ready", scanner.Text())
	rotatedToken := rotateB()
	require.NoError(t, os.WriteFile(pathB, []byte(rotatedToken), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(home, "foreign"), []byte(rotatedToken), 0600))
	auth, err = json.Marshal(map[string]string{"api_url": server.URL, "token": rotatedToken})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(home, "auth.json"), auth, 0600))
	_, err = input.Write([]byte("rotated\n"))
	require.NoError(t, err)
	if !scanner.Scan() {
		require.NoError(t, command.Wait(), errors.String())
		t.Fatal("cache probe exited before B rotation resolved")
	}
	require.Equal(t, "cache-rotated", scanner.Text())
	return func() {
		_, err := input.Write([]byte("closed\n"))
		require.NoError(t, err)
		if !scanner.Scan() {
			require.NoError(t, command.Wait(), errors.String())
			t.Fatal("cache probe exited without qualifying exact eviction")
		}
		require.Equal(t, "cache-qualified", scanner.Text())
		require.NoError(t, command.Wait(), errors.String())
		require.EqualValues(t, 1, mutations.Load(), "only the original revoked POST reaches the production router; no replay or fallback mutation")
	}
}
