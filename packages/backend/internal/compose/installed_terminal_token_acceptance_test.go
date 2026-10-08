package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Observe issuer output on the host while retaining every production write,
// permission check and daemon operation. Bearers stay in memory, never logs,
// files, argv or terminal output. This supplies no credentials or guest doubles.
type inspectedTerminalRuntime struct {
	*microsandbox.Runtime
	mu     sync.Mutex
	tokens map[string]string
}

func (r *inspectedTerminalRuntime) SessionCredentialsForMember(ctx context.Context, branch string, member microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error) {
	writer, err := r.Runtime.SessionCredentialsForMember(ctx, branch, member)
	if err != nil {
		return nil, err
	}
	return inspectedTerminalWriter{writer, r}, nil
}

type inspectedTerminalWriter struct {
	microsandbox.MemberSessionCredentials
	inspection *inspectedTerminalRuntime
}

func (w inspectedTerminalWriter) PutSessionToken(ctx context.Context, branch, session string, token []byte, expected string) (string, error) {
	path, err := w.MemberSessionCredentials.PutSessionToken(ctx, branch, session, token, expected)
	if err == nil {
		w.inspection.mu.Lock()
		w.inspection.tokens[session] = string(token)
		w.inspection.mu.Unlock()
	}
	return path, err
}

// The child checks the actual environment, inherited descriptors and every
// readable session file. An accessible credential must authenticate as
// delegated; only redacted observations are returned to the terminal.
const installedTerminalBearerInspection = `import json,os,pathlib,urllib.request
assert 'SMITHERS_TOKEN' not in os.environ
assert not any('PERSON' in key and ('TOKEN' in key or 'BEARER' in key) for key in os.environ)
for fd in os.listdir('/proc/self/fd'):
 try: target=os.readlink('/proc/self/fd/'+fd)
 except FileNotFoundError: continue
 assert int(fd)<=2, (fd,target)
paths=list(pathlib.Path('/run/smithers').glob('**/sessions/*/token'))
assert pathlib.Path(os.environ['SMITHERS_TOKEN_FILE']) in paths
for path in paths:
 try: token=path.read_text().strip()
 except PermissionError: continue
 request=urllib.request.Request(os.environ['SMITHERS_URL'].rstrip('/')+'/api/user',headers={'Authorization':'Bearer '+token})
 with urllib.request.urlopen(request) as response:
  identity=json.load(response)
 assert identity['credential_kind']=='delegated', path
print('TRM'+'BEARERS=delegated')
`

func testInstalledTerminalTokenAcceptance(t *testing.T, h *rootLayerHarness, branch string, ben, alice http.CookieJar) {
	t.Helper()
	original := h.options.Workspace
	defer func() { h.options.Workspace = original; h.recompose() }()
	runtime := &inspectedTerminalRuntime{Runtime: h.runtime, tokens: map[string]string{}}
	h.options.Workspace = runtime
	h.recompose()
	requests := &rehearsal{ctx: t.Context(), origin: h.origin, jar: h.jar, client: h.client, fake: h.github}
	for _, event := range []string{"member removal", "machine sleep"} {
		t.Run("native token scope and session bookkeeping/"+event, func(t *testing.T) {
			browser := ben
			login := "ben"
			if event == "member removal" {
				login = "terminal-revoke"
				var err error
				browser, err = requests.member(login, 18, "write")
				require.NoError(t, err)
			}
			term := installedMemberTerminal(t, h, branch, browser)
			defer term.close()
			installedShell(t, term, "/usr/bin/python3 - <<'TRMINSPECT'\n"+installedTerminalBearerInspection+"\nTRMINSPECT")
			var uid int
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT unix_uid FROM collaborators WHERE repository_id=(SELECT repository_id FROM workspaces WHERE id=$1) AND user_id=(SELECT id FROM users WHERE username=$2)`, branch, login).Scan(&uid))
			runtime.mu.Lock()
			var session, token string
			for candidate, bearer := range runtime.tokens {
				var user string
				err := h.pool.QueryRow(t.Context(), `SELECT u.username FROM access_tokens a JOIN users u ON u.id=a.user_id WHERE a.name=$1`, "terminal-session-"+candidate).Scan(&user)
				if err == nil && user == login {
					session, token = candidate, bearer
				}
			}
			runtime.mu.Unlock()
			require.NotEmpty(t, session)
			require.True(t, token != "", "host did not observe the issued credential")
			path := fmt.Sprintf("/run/smithers/%d/token/sessions/%s/token", uid, session)
			denied := fmt.Sprintf("/usr/bin/python3 - <<'TRMDENIED'\nimport errno,os\nfor path in (%q,%q):\n try:\n  fd=os.open(path,os.O_RDONLY); os.close(fd)\n except OSError as error:\n  assert error.errno==errno.EACCES, (path,error.errno)\n else:\n  raise AssertionError('session credential readable')\nTRMDENIED", fmt.Sprintf("/run/smithers/%d/token", uid), path)
			observer := installedMemberTerminal(t, h, branch, alice)
			installedShell(t, observer, denied)
			observer.close()
			result, err := h.runtime.ExecuteCommand(t.Context(), branch, workspaceapi.Command{Args: []string{"/bin/sh", "-c", denied}})
			require.NoError(t, err)
			require.Zero(t, result.ExitCode, result.Stdout+result.Stderr)
			status := func() int {
				request, err := http.NewRequestWithContext(t.Context(), "GET", h.origin+"/api/user", nil)
				require.NoError(t, err)
				request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
				response, err := http.DefaultClient.Do(request)
				require.NoError(t, err)
				defer response.Body.Close()
				if response.StatusCode == 401 {
					var body map[string]any
					require.NoError(t, json.NewDecoder(response.Body).Decode(&body))
					require.Equal(t, "permission", body["class"])
					require.Equal(t, "unauthenticated", body["code"])
				}
				return response.StatusCode
			}
			require.Equal(t, 200, status())
			started := time.Now()
			if event == "member removal" {
				h.expect("DELETE", "/api/members/"+login, "", 204)
			} else {
				code, body := h.request("POST", "/api/branches/"+branch, `{"op":"sleep"}`, uuid.NewString())
				require.Equal(t, 202, code, string(body))
			}
			require.Eventually(t, func() bool { return status() == 401 }, time.Until(started.Add(5*time.Second)), 10*time.Millisecond)
			revokedAfter := time.Since(started)
			var live int
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens WHERE name=$1`, "terminal-session-"+session).Scan(&live))
			require.Zero(t, live)
			// A real surviving/woken session inspects physical file removal. Token
			// reuse remains refused after the machine has restarted its guest.
			survivor := installedMemberTerminal(t, h, branch, ben)
			installedShell(t, survivor, fmt.Sprintf("test ! -e %q && test -r \"$SMITHERS_TOKEN_FILE\"", path))
			require.Equal(t, 401, status())
			survivor.close()
			t.Logf("terminal revocation: event=%s elapsed=%s status=401 token_rows=0", event, revokedAfter)
		})
	}
}
