package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Only the lifecycle facet is exercised. An unexpected call to another
// embedded runtime method panics, keeping this fake narrower than production.
type cleanupRuntime struct {
	workspace.WorkspaceRuntime
	calls              []string
	contexts           []context.Context
	stopErr, deleteErr error
	ids                []string
}

func (r *cleanupRuntime) StopService(ctx context.Context, id, name string) error {
	r.calls = append(r.calls, "stop:"+id+":"+name)
	r.contexts = append(r.contexts, ctx)
	return r.stopErr
}
func (r *cleanupRuntime) DeleteWorkspace(ctx context.Context, id string) error {
	r.calls = append(r.calls, "delete:"+id)
	r.contexts = append(r.contexts, ctx)
	return r.deleteErr
}
func (r *cleanupRuntime) WorkspaceIDs() []string { return append([]string(nil), r.ids...) }

func TestLocalLeaseCleanupRetainsFailedDeleteAndRetries(t *testing.T) {
	stopErr := errors.New("stop failed")
	deleteErr := errors.New("delete failed")
	for _, tc := range []struct {
		name         string
		stop, delete error
	}{{"success", nil, nil}, {"stop failed", stopErr, nil}, {"delete failed", nil, deleteErr}, {"both failed", stopErr, deleteErr}} {
		t.Run(tc.name, func(t *testing.T) {
			runtime := &cleanupRuntime{stopErr: tc.stop, deleteErr: tc.delete}
			launcher := &LocalLauncher{runtime: runtime, active: map[string]struct{}{"chat-model-one": {}}}
			client := &http.Client{}
			lease := &localLease{launcher: launcher, workspaceID: "chat-model-one", endpoint: "https://private.test", client: client, token: "token"}
			endpoint, actualClient, token := lease.Endpoint()
			require.Equal(t, "https://private.test", endpoint)
			require.Same(t, client, actualClient)
			require.Equal(t, "token", token)
			ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(time.Minute))
			cancel()
			err := lease.Close(ctx)
			if tc.stop != nil {
				require.ErrorIs(t, err, stopErr)
			}
			if tc.delete != nil {
				require.ErrorIs(t, err, deleteErr)
			}
			if tc.stop == nil && tc.delete == nil {
				require.NoError(t, err)
			}
			require.Equal(t, []string{"stop:chat-model-one:model-host", "delete:chat-model-one"}, runtime.calls)
			require.Equal(t, tc.delete != nil, len(launcher.active) == 1)
			for _, seen := range runtime.contexts {
				require.Same(t, ctx, seen)
				require.ErrorIs(t, seen.Err(), context.Canceled)
				_, ok := seen.Deadline()
				require.True(t, ok)
			}
			runtime.calls = nil
			runtime.stopErr = nil
			runtime.deleteErr = nil
			require.NoError(t, launcher.Close(context.Background()))
			if tc.delete != nil {
				require.Equal(t, []string{"stop:chat-model-one:model-host", "delete:chat-model-one"}, runtime.calls)
			} else {
				require.Empty(t, runtime.calls)
			}
			require.Empty(t, launcher.active)
			runtime.calls = nil
			require.NoError(t, launcher.Close(context.Background()))
			require.Empty(t, runtime.calls)
		})
	}
}

func TestLocalLauncherOrphanCleanupPreservesOtherWorkspacesAndJoinsErrors(t *testing.T) {
	deletionErr := errors.New("delete unavailable")
	runtime := &cleanupRuntime{ids: []string{"user-workspace", "chat-model-one", "other-chat-model-two", "chat-model-two"}, deleteErr: deletionErr}
	launcher := &LocalLauncher{runtime: runtime, active: make(map[string]struct{})}
	require.ErrorIs(t, launcher.removeOrphans(), deletionErr)
	require.Equal(t, []string{"delete:chat-model-one", "delete:chat-model-two"}, runtime.calls)
	for _, ctx := range runtime.contexts {
		require.ErrorIs(t, ctx.Err(), context.Canceled)
		_, ok := ctx.Deadline()
		require.True(t, ok)
	}
	runtime.calls = nil
	runtime.contexts = nil
	runtime.deleteErr = nil
	require.NoError(t, launcher.removeOrphans())
	require.Equal(t, []string{"delete:chat-model-one", "delete:chat-model-two"}, runtime.calls)
	require.NoError(t, (&LocalLauncher{runtime: struct{ workspace.WorkspaceRuntime }{runtime}}).removeOrphans())
}

func TestCredentialEnvironmentBindingBoundaries(t *testing.T) {
	for _, size := range []int{65535, 65536, 65537} {
		model := json.RawMessage(`"` + strings.Repeat("x", size-2) + `"`)
		env, err := credentialEnvironment(Binding{Model: model, CredentialName: "OPENAI_API_KEY", CredentialValue: " secret "})
		if size > 65536 {
			require.Nil(t, env)
			require.EqualError(t, err, "model binding is invalid")
		} else {
			require.NoError(t, err)
			require.Equal(t, map[string]string{"OPENAI_API_KEY": " secret "}, env)
		}
	}
	for _, model := range []json.RawMessage{nil, json.RawMessage(`{`)} {
		env, err := credentialEnvironment(Binding{Model: model, CredentialName: "OPENAI_API_KEY", CredentialValue: "key"})
		require.Nil(t, env)
		require.EqualError(t, err, "model binding is invalid")
	}
	for _, name := range []string{"", "a", "_CUSTOM", "CUSTOM__KEY", "CUSTOM_KEY_", "CUSTOM_ORIGIN"} {
		env, err := credentialEnvironment(Binding{Model: json.RawMessage(`{}`), CredentialName: name, CredentialValue: "key"})
		require.Nil(t, env)
		require.Error(t, err)
	}
	for _, value := range []string{"", " \t\r\n"} {
		env, err := credentialEnvironment(Binding{Model: json.RawMessage(`{}`), CredentialName: "OPENAI_API_KEY", CredentialValue: value})
		require.Nil(t, env)
		require.EqualError(t, err, "model credential binding is invalid")
	}
	binding := Binding{Model: json.RawMessage(`{}`), CredentialName: "CUSTOM_KEY", CredentialOrigin: "https://models.example", CredentialValue: "key"}
	env, err := credentialEnvironment(binding)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"SMITHERS_MODEL_KEY_CUSTOM_KEY": "key", "SMITHERS_MODEL_KEY_CUSTOM_KEY_ORIGIN": "https://models.example"}, env)
	env["SMITHERS_MODEL_KEY_CUSTOM_KEY_ORIGIN"] = "changed"
	require.Equal(t, "https://models.example", binding.CredentialOrigin)
	binding.CredentialOrigin = " \t"
	env, err = credentialEnvironment(binding)
	require.Nil(t, env)
	require.EqualError(t, err, "custom model credential requires a pinned origin")
	for _, name := range []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY"} {
		env, err := credentialEnvironment(Binding{Model: json.RawMessage(`{}`), CredentialName: name, CredentialValue: "key", CredentialOrigin: "ignored"})
		require.NoError(t, err)
		require.Equal(t, map[string]string{name: "key"}, env)
	}
}

func TestModelHostProtocolProbeClosesEveryResponse(t *testing.T) {
	readErr := errors.New("read broken")
	for _, tc := range []struct {
		name    string
		status  int
		body    io.Reader
		success bool
	}{{"valid", 200, strings.NewReader(`{"protocol":"smithers.chat-model-host/v1"}`), true}, {"wrong status", 201, strings.NewReader(`{"protocol":"smithers.chat-model-host/v1"}`), false}, {"invalid json", 200, strings.NewReader(`{`), false}, {"wrong protocol", 200, strings.NewReader(`{"protocol":"different"}`), false}, {"empty", 200, strings.NewReader(`{}`), false}, {"read error", 200, &failingBody{err: readErr}, false}, {"protocol beyond cap", 200, strings.NewReader(strings.Repeat(" ", 256) + `{"protocol":"smithers.chat-model-host/v1"}`), false}} {
		t.Run(tc.name, func(t *testing.T) {
			closed := false
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				require.Equal(t, http.MethodGet, request.Method)
				require.Equal(t, "https://private.test/health", request.URL.String())
				return &http.Response{StatusCode: tc.status, Header: make(http.Header), Body: &trackingReadCloser{Reader: tc.body, closed: &closed}}, nil
			})}
			err := probe(context.Background(), client, "https://private.test")
			if tc.success {
				require.NoError(t, err)
			} else {
				require.EqualError(t, err, "model host protocol identity mismatch")
			}
			require.True(t, closed)
		})
	}
	transportErr := errors.New("offline")
	dispatched := false
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) { dispatched = true; return nil, transportErr })}
	require.Error(t, probe(context.Background(), client, "http://["))
	require.False(t, dispatched)
	require.ErrorIs(t, probe(context.Background(), client, "https://private.test"), transportErr)
	require.True(t, dispatched)
}

func TestEqualDigestChecksLengthAndEveryByte(t *testing.T) {
	require.True(t, equalDigest(nil, nil))
	require.True(t, equalDigest([]byte{0, 1, 255}, []byte{0, 1, 255}))
	require.False(t, equalDigest([]byte{0}, nil))
	require.False(t, equalDigest(nil, []byte{0}))
	for _, right := range [][]byte{{1, 1, 255}, {0, 2, 255}, {0, 1, 254}} {
		require.False(t, equalDigest([]byte{0, 1, 255}, right))
	}
}

type launchFailureRuntime struct {
	cleanupRuntime
	createErr, startErr error
	createdID           string
}

func (r *launchFailureRuntime) CreateWorkspace(ctx context.Context, spec workspace.WorkspaceSpec) (workspace.Workspace, error) {
	r.calls = append(r.calls, "create")
	r.createdID = spec.ID
	return workspace.Workspace{}, r.createErr
}
func (r *launchFailureRuntime) StartWorkspace(ctx context.Context, id string) (workspace.Workspace, error) {
	r.calls = append(r.calls, "start:"+id)
	return workspace.Workspace{}, r.startErr
}

func TestLocalLaunchFailureCleansOnlyCreatedWorkspace(t *testing.T) {
	createErr := errors.New("create failed")
	startErr := errors.New("start failed")
	stopErr := errors.New("stop failed")
	deleteErr := errors.New("delete failed")
	for _, tc := range []struct {
		name                        string
		create, start, stop, delete error
	}{{"create refused", createErr, nil, nil, nil}, {"start refused", nil, startErr, nil, nil}, {"cleanup refused", nil, startErr, stopErr, deleteErr}} {
		t.Run(tc.name, func(t *testing.T) {
			runtime := &launchFailureRuntime{cleanupRuntime: cleanupRuntime{stopErr: tc.stop, deleteErr: tc.delete}, createErr: tc.create, startErr: tc.start}
			launcher := &LocalLauncher{runtime: runtime, node: "/packaged/node", bundle: "/packaged/host", active: make(map[string]struct{})}
			lease, err := launcher.LaunchChatHost(context.Background(), ports.ChatTurnGrant{OwnerID: 7, TurnID: "turn", ProducerBaseURL: "http://127.0.0.1:8080"}, Binding{Model: json.RawMessage(`{}`), CredentialName: "OPENAI_API_KEY", CredentialValue: "key"})
			require.Nil(t, lease)
			require.Regexp(t, `^chat-model-[a-f0-9]{32}$`, runtime.createdID)
			if tc.create != nil {
				require.ErrorIs(t, err, createErr)
				require.Equal(t, []string{"create"}, runtime.calls)
				require.Empty(t, launcher.active)
			} else {
				require.ErrorIs(t, err, startErr)
				require.Equal(t, []string{"create", "start:" + runtime.createdID, "stop:" + runtime.createdID + ":model-host", "delete:" + runtime.createdID}, runtime.calls)
				if tc.stop != nil {
					require.ErrorIs(t, err, stopErr)
				}
				if tc.delete != nil {
					require.ErrorIs(t, err, deleteErr)
					require.Contains(t, launcher.active, runtime.createdID)
				} else {
					require.Empty(t, launcher.active)
				}
				for _, ctx := range runtime.contexts {
					_, bounded := ctx.Deadline()
					require.True(t, bounded)
					require.ErrorIs(t, ctx.Err(), context.Canceled)
				}
			}
		})
	}
}

func TestLocalLaunchRejectsInvalidGrantBeforeRuntime(t *testing.T) {
	launcher := &LocalLauncher{runtime: struct{ workspace.WorkspaceRuntime }{}, active: make(map[string]struct{})}
	binding := Binding{Model: json.RawMessage(`{}`), CredentialName: "OPENAI_API_KEY", CredentialValue: "key"}
	for _, grant := range []ports.ChatTurnGrant{{}, {OwnerID: -1, TurnID: "turn", ProducerBaseURL: "http://localhost"}, {OwnerID: 7, ProducerBaseURL: "http://localhost"}, {OwnerID: 7, TurnID: "turn"}} {
		lease, err := launcher.LaunchChatHost(context.Background(), grant, binding)
		require.Nil(t, lease)
		require.EqualError(t, err, "chat model host grant is incomplete")
	}
	for _, callback := range []string{"http://[", "https://localhost", "http://external.example", "file:///tmp/callback"} {
		lease, err := launcher.LaunchChatHost(context.Background(), ports.ChatTurnGrant{OwnerID: 7, TurnID: "turn", ProducerBaseURL: callback}, binding)
		require.Nil(t, lease)
		require.EqualError(t, err, "local model host callback must be loopback")
	}
	lease, err := launcher.LaunchChatHost(context.Background(), ports.ChatTurnGrant{OwnerID: 7, TurnID: "turn", ProducerBaseURL: "http://localhost"}, Binding{})
	require.Nil(t, lease)
	require.EqualError(t, err, "model credential binding is invalid")
}
