package modelhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// recordedRuntime is the real trusted-process runtime. It remembers what each
// started service was given, so a test can read the environment of a real host.
type recordedRuntime struct {
	workspace.WorkspaceRuntime
	mu       sync.Mutex
	launches []recordedLaunch
}
type recordedLaunch struct {
	workspace   string
	environment map[string]string
}

func (r *recordedRuntime) StartService(ctx context.Context, workspaceID string, spec workspace.ServiceSpec) (workspace.Service, error) {
	environment := make(map[string]string, len(spec.Command.Environment))
	for key, value := range spec.Command.Environment {
		environment[key] = value
	}
	r.mu.Lock()
	r.launches = append(r.launches, recordedLaunch{workspace: workspaceID, environment: environment})
	r.mu.Unlock()
	return r.WorkspaceRuntime.StartService(ctx, workspaceID, spec)
}

func (r *recordedRuntime) started() []recordedLaunch {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedLaunch(nil), r.launches...)
}

// packagedBundle builds the install's real model-host bundle and its checksum.
func packagedBundle(t *testing.T) (node, bundle, repository string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node 26.4+ is required to run the packaged model host")
	}
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	_, source, _, ok := goruntime.Caller(0)
	require.True(t, ok)
	repository = filepath.Clean(filepath.Join(filepath.Dir(source), "../../.."))
	bundle = filepath.Join(t.TempDir(), "model-host.mjs")
	build := exec.CommandContext(t.Context(), node, filepath.Join(repository, "apps/model-host/build.mjs"), bundle)
	build.Dir = repository
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	require.NoError(t, os.Chmod(bundle, 0o755))
	contents, err := os.ReadFile(bundle)
	require.NoError(t, err)
	digest := sha256.Sum256(contents)
	require.NoError(t, os.WriteFile(bundle+".sha256", []byte(hex.EncodeToString(digest[:])+"  model-host.mjs\n"), 0o644))
	return node, bundle, repository
}

// The install normalizes a member's transcript in one long-lived packaged host
// that holds no provider credential, resolves no owner model, survives the
// host's exit by continuing from the caller's checkpoint, and is gone after
// Close. The bundle, the launcher and the process runtime are the real ones.
func TestHostNormalizesTranscriptsInOneCredentialFreePackagedHost(t *testing.T) {
	node, bundle, repository := packagedBundle(t)
	root := t.TempDir()
	trusted, err := process.New(process.Config{Root: filepath.Join(root, "runtime")})
	require.NoError(t, err)
	defer trusted.Close()
	runtime := &recordedRuntime{WorkspaceRuntime: trusted}
	launcher, err := NewLocalLauncher(LocalConfig{Runtime: runtime, NodeBinary: node, BundlePath: bundle})
	require.NoError(t, err)
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		t.Error("normalizing a transcript resolved an owner's model credential")
		return Binding{}, errors.New("no model for transcripts")
	}), launcher)
	require.NoError(t, err)

	registration := map[string]string{"owner_id": "42", "participant_id": "01000000-0000-0000-0000-000000000000", "session_id": "9", "source_generation": "02000000-0000-0000-0000-000000000000:1"}
	fixture := func(directory, file string) []string {
		data, err := os.ReadFile(filepath.Join(repository, "packages/smithers/agent/harness/test/fixtures/external", directory, file))
		require.NoError(t, err)
		return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	}
	type draft struct{ kind, source, author, text string }
	// replay sends every record in order, each with the checkpoint the last one
	// returned, and returns what the host produced.
	replay := func(profile string, records []string, between func(index int)) (drafts []draft, state json.RawMessage) {
		t.Helper()
		var offset uint64
		for index, record := range records {
			if between != nil {
				between(index)
			}
			end := offset + uint64(len(record)) + 1
			normalized, err := host.NormalizeExternalTranscript(t.Context(), chat.ExternalNormalizeInput{Profile: profile, Context: registration, Record: record, Start: offset, End: end, State: state})
			require.NoError(t, err, "record %d", index+1)
			for _, entry := range normalized.Entries {
				var body struct {
					Text    string `json:"text"`
					Message string `json:"message"`
				}
				require.NoError(t, json.Unmarshal(entry.Body, &body))
				drafts = append(drafts, draft{entry.Kind, entry.SourceID, entry.Author, body.Text + body.Message})
			}
			state, offset = normalized.State, end
		}
		return drafts, state
	}

	// The two signed-out captures are whole sessions the installed CLIs wrote.
	claude := fixture("claude-code-signed-out-2.1", "session.jsonl")
	claudeDrafts, claudeState := replay("claude-code/2.1", claude, nil)
	require.Equal(t, []draft{
		{"prompt", "889e416d-fda3-42c0-869a-56b3ced78a05:3", "42", "Create sample.txt containing the word alpha, then print it."},
		{"error", "889e416d-fda3-42c0-869a-56b3ced78a05:16", "01000000-0000-0000-0000-000000000000", "Not logged in · Please run /login"},
	}, claudeDrafts)
	codex := fixture("codex-signed-out-0.160", "rollout.jsonl")
	codexDrafts, _ := replay("codex-rollout/0.160", codex, nil)
	require.Equal(t, "prompt", codexDrafts[0].kind)
	require.Equal(t, "42", codexDrafts[0].author)
	require.Equal(t, "error", codexDrafts[1].kind)
	require.Contains(t, codexDrafts[1].text, "401 Unauthorized")

	// Thirty records of two agents used one process, and its environment holds
	// a private bearer and nothing a provider would accept.
	launches := runtime.started()
	require.Len(t, launches, 1)
	names := make([]string, 0, len(launches[0].environment))
	for name := range launches[0].environment {
		names = append(names, name)
	}
	sort.Strings(names)
	require.Equal(t, []string{"SMITHERS_CHAT_CALLBACK_URL", "SMITHERS_CHAT_HOST_PARENT_PID", "SMITHERS_CHAT_HOST_TOKEN", "SMITHERS_CHAT_MODEL"}, names)
	require.Equal(t, "{}", launches[0].environment["SMITHERS_CHAT_MODEL"])
	require.Len(t, launches[0].environment["SMITHERS_CHAT_HOST_TOKEN"], 64)

	// The adapter's refusal and a request the host will not trust come back as
	// they are. Neither replaces a healthy host.
	future := `{"type":"future-semantic-record"}`
	_, err = host.NormalizeExternalTranscript(t.Context(), chat.ExternalNormalizeInput{Profile: "claude-code/2.1", Context: registration, Record: future, Start: 0, End: uint64(len(future)) + 1})
	var refusal *chat.ExternalRefusal
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, chat.ExternalRefusal{Reason: "unsupported_record", Line: 1}, *refusal)
	_, err = host.NormalizeExternalTranscript(t.Context(), chat.ExternalNormalizeInput{Profile: "claude-code/2.1", Context: registration, Record: future, Start: 7, End: uint64(len(future)) + 8})
	require.ErrorIs(t, err, chat.ErrExternalInvalid)
	forged := map[string]string{"owner_id": "../../other-home", "participant_id": registration["participant_id"], "session_id": "9", "source_generation": registration["source_generation"]}
	_, err = host.NormalizeExternalTranscript(t.Context(), chat.ExternalNormalizeInput{Profile: "claude-code/2.1", Context: forged, Record: future, Start: 0, End: uint64(len(future)) + 1})
	require.ErrorIs(t, err, chat.ErrExternalInvalid)
	require.Len(t, runtime.started(), 1)

	// The host process dies between two records of a session. The next record
	// starts one new host and the session continues from the caller's
	// checkpoint: the same drafts, the same final state.
	again, state := replay("claude-code/2.1", claude, func(index int) {
		if index == 10 {
			live := runtime.started()
			require.NoError(t, trusted.StopService(t.Context(), live[len(live)-1].workspace, "model-host"))
		}
	})
	require.Equal(t, claudeDrafts, again)
	require.JSONEq(t, string(claudeState), string(state))
	launches = runtime.started()
	require.Len(t, launches, 2)
	require.NotEqual(t, launches[0].environment["SMITHERS_CHAT_HOST_TOKEN"], launches[1].environment["SMITHERS_CHAT_HOST_TOKEN"])

	// A turn sent to this host with its own bearer has no model to run: the
	// transcript host cannot be used to spend anyone's credential.
	live := launches[1]
	lease := host.transcripts.(*localLease)
	require.Equal(t, live.workspace, lease.workspaceID)
	turn, err := http.NewRequestWithContext(t.Context(), http.MethodPost, lease.endpoint+chat.ModelHostTurnPath, strings.NewReader(`{"runId":"r","messages":[{"role":"user","content":"hi"}]}`))
	require.NoError(t, err)
	turn.Header.Set("Authorization", "Bearer "+lease.token)
	turn.Header.Set("Content-Type", "application/json")
	response, err := lease.client.Do(turn)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())
	require.NotEqual(t, http.StatusOK, response.StatusCode)

	require.NoError(t, host.Close(context.Background()))
	entries, err := os.ReadDir(filepath.Join(root, "runtime", "workspaces"))
	require.NoError(t, err)
	require.Empty(t, entries)
	require.Nil(t, host.transcripts)
}

type chatOnlyLauncher struct{}

func (chatOnlyLauncher) LaunchChatHost(context.Context, ports.ChatTurnGrant, Binding) (Lease, error) {
	return nil, errors.New("a transcript launched a chat host")
}

// failingTranscriptLauncher hands out leases to hosts that never answer.
type failingTranscriptLauncher struct {
	chatOnlyLauncher
	launched, closed int
	launchErr        error
}
type deadLease struct{ launcher *failingTranscriptLauncher }

func (l *failingTranscriptLauncher) LaunchTranscriptHost(context.Context) (Lease, error) {
	if l.launchErr != nil {
		return nil, l.launchErr
	}
	l.launched++
	return deadLease{l}, nil
}

// Port 9 is discard: nothing listens, so every request fails to connect.
func (deadLease) Endpoint() (string, *http.Client, string) { return "http://127.0.0.1:9", nil, "token" }
func (l deadLease) Close(context.Context) error            { l.launcher.closed++; return nil }

func TestHostTranscriptNormalizationRefusesWithoutAHost(t *testing.T) {
	resolver := ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		t.Error("normalizing a transcript resolved an owner's model credential")
		return Binding{}, nil
	})
	input := chat.ExternalNormalizeInput{Profile: "claude-code/2.1", Record: "{}", End: 3}

	// A deployment whose launcher starts only credentialed chat hosts imports no transcript.
	host, err := New(resolver, chatOnlyLauncher{})
	require.NoError(t, err)
	_, err = host.NormalizeExternalTranscript(t.Context(), input)
	require.ErrorIs(t, err, ErrTranscriptHostUnavailable)
	require.NoError(t, host.Close(t.Context()))

	// A host that cannot start is the error; nothing is kept to close.
	launcher := &failingTranscriptLauncher{launchErr: errors.New("no node")}
	host, err = New(resolver, launcher)
	require.NoError(t, err)
	_, err = host.NormalizeExternalTranscript(t.Context(), input)
	require.ErrorContains(t, err, "launch transcript host: no node")
	require.Nil(t, host.transcripts)

	// A host that never answers is replaced once, each one closed, and the
	// failure returned: the record stays with its sender to be replayed.
	launcher.launchErr = nil
	_, err = host.NormalizeExternalTranscript(t.Context(), input)
	require.Error(t, err)
	var refusal *chat.ExternalRefusal
	require.False(t, errors.As(err, &refusal))
	require.NotErrorIs(t, err, chat.ErrExternalInvalid)
	require.Equal(t, 2, launcher.launched)
	require.Equal(t, 2, launcher.closed)
	require.Nil(t, host.transcripts)

	// A caller that gave up is not answered by a second launch.
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = host.NormalizeExternalTranscript(cancelled, input)
	require.Error(t, err)
	require.LessOrEqual(t, launcher.launched, 3)
}
