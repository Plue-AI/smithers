package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/chat/turncredential"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
)

const testProxyURL = "https://api.example.test" + modelproxy.Path

func ownerResolving(binding Binding, err error) Resolver {
	return ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) { return binding, err })
}

func TestManagedModelsServeOnlyAnOwnerWithNoModel(t *testing.T) {
	keys := modelproxy.StaticKeys{modelproxy.ProviderOpenAI: "sk-openai", modelproxy.ProviderAnthropic: "sk-anthropic"}
	managed, err := NewManagedModels(ownerResolving(Binding{}, ErrOwnerModelUnset), keys, testProxyURL+"/")
	require.NoError(t, err)
	binding, err := managed.ResolveChatModel(context.Background(), 7, 0, json.RawMessage(`{}`))
	require.NoError(t, err)
	require.True(t, binding.Managed)
	require.Empty(t, binding.CredentialValue, "a resolver never supplies the managed credential")
	require.Equal(t, ManagedCredentialName, binding.CredentialName)
	require.Equal(t, "https://api.example.test", binding.CredentialOrigin)
	require.JSONEq(t, `{"protocol":"anthropic-messages","modelId":"claude-sonnet-5","credential":"SMITHERS_MANAGED","baseUrl":"https://api.example.test/model-proxy/anthropic"}`, string(binding.Model))

	// Only offered providers serve.
	managed, err = NewManagedModels(ownerResolving(Binding{}, ErrOwnerModelUnset), modelproxy.StaticKeys{modelproxy.ProviderOpenAI: "sk-openai"}, testProxyURL)
	require.NoError(t, err)
	binding, err = managed.ResolveChatModel(context.Background(), 7, 0, json.RawMessage(`{}`))
	require.NoError(t, err)
	require.JSONEq(t, `{"protocol":"openai-responses","modelId":"gpt-6-sol","credential":"SMITHERS_MANAGED","baseUrl":"https://api.example.test/model-proxy/openai"}`, string(binding.Model))

	// No offered provider leaves the missing credential.
	managed, err = NewManagedModels(ownerResolving(Binding{}, ErrOwnerModelUnset), modelproxy.StaticKeys{}, testProxyURL)
	require.NoError(t, err)
	_, err = managed.ResolveChatModel(context.Background(), 7, 0, json.RawMessage(`{}`))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)

	// An owner's explicit model and its failures are never substituted.
	for _, ownerErr := range []error{ports.ErrModelCredentialMissing, errors.New("owner model store is unavailable")} {
		managed, err = NewManagedModels(ownerResolving(Binding{}, ownerErr), keys, testProxyURL)
		require.NoError(t, err)
		binding, err = managed.ResolveChatModel(context.Background(), 7, 0, json.RawMessage(`{"model":{"protocol":"anthropic-messages","modelId":"claude-opus-5-5","credential":"ANTHROPIC_API_KEY"}}`))
		require.ErrorIs(t, err, ownerErr)
		require.False(t, binding.Managed)
	}
	own := Binding{Model: json.RawMessage(`{"protocol":"openai-responses","modelId":"gpt-6-sol","credential":"OPENAI_API_KEY"}`), CredentialName: "OPENAI_API_KEY", CredentialValue: "sk-own"}
	managed, err = NewManagedModels(ownerResolving(own, nil), keys, testProxyURL)
	require.NoError(t, err)
	binding, err = managed.ResolveChatModel(context.Background(), 7, 0, json.RawMessage(`{}`))
	require.NoError(t, err)
	require.Equal(t, own, binding)
}

func TestManagedDefaultsArePricedOnTheirProvider(t *testing.T) {
	for _, managed := range managedDefaults {
		_, _, ok := modelproxy.Price(managed.provider, managed.modelID)
		require.True(t, ok, "%s on %s is not metered", managed.modelID, managed.provider)
	}
}

func TestManagedModelsCerebrasFallbackAndProviderRotation(t *testing.T) {
	for _, placeholders := range []bool{false, true} {
		t.Run(map[bool]string{false: "cerebras only", true: "placeholder preferred keys"}[placeholders], func(t *testing.T) {
			configured := map[string]string{modelproxy.ProviderCerebras: "cerebras-private-fixture"}
			if placeholders {
				configured[modelproxy.ProviderAnthropic] = "placeholder-anthropic"
				configured[modelproxy.ProviderOpenAI] = "replace-me-openai"
			}
			keys := modelproxy.NewStaticKeys(configured)
			managed, err := NewManagedModels(ownerResolving(Binding{}, ErrOwnerModelUnset), keys, testProxyURL)
			require.NoError(t, err)
			resolve := func(provider, protocol, modelID string) {
				t.Helper()
				binding, err := managed.ResolveChatModel(context.Background(), 7, 0, json.RawMessage(`{}`))
				require.NoError(t, err)
				require.True(t, binding.Managed)
				require.Empty(t, binding.CredentialValue)
				require.Equal(t, ManagedCredentialName, binding.CredentialName)
				require.Equal(t, "https://api.example.test", binding.CredentialOrigin)
				expected, err := json.Marshal(map[string]string{"protocol": protocol, "modelId": modelID, "credential": ManagedCredentialName, "baseUrl": testProxyURL + "/" + provider})
				require.NoError(t, err)
				require.JSONEq(t, string(expected), string(binding.Model))
				for _, secret := range configured {
					require.NotContains(t, string(binding.Model), secret)
				}
				_, _, priced := modelproxy.Price(provider, modelID)
				require.True(t, priced)
			}
			resolve(modelproxy.ProviderCerebras, "openai-chat", "gpt-oss-120b")
			keys[modelproxy.ProviderOpenAI] = "openai-private-fixture"
			resolve(modelproxy.ProviderOpenAI, "openai-responses", "gpt-6-sol")
			keys[modelproxy.ProviderAnthropic] = "anthropic-private-fixture"
			resolve(modelproxy.ProviderAnthropic, "anthropic-messages", "claude-sonnet-5")
			delete(keys, modelproxy.ProviderAnthropic)
			delete(keys, modelproxy.ProviderOpenAI)
			resolve(modelproxy.ProviderCerebras, "openai-chat", "gpt-oss-120b")
			delete(keys, modelproxy.ProviderCerebras)
			_, err = managed.ResolveChatModel(context.Background(), 7, 0, json.RawMessage(`{}`))
			require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
		})
	}
}

func TestManagedModelsRefuseAnUnsafeProxy(t *testing.T) {
	owner := ownerResolving(Binding{}, nil)
	keys := modelproxy.StaticKeys{}
	for _, proxy := range []string{"", "http://api.example.test" + modelproxy.Path, "https://api.example.test", "https://user@api.example.test" + modelproxy.Path, "https://api.example.test/api/model", "https://api.example.test" + modelproxy.Path + "?x=1"} {
		_, err := NewManagedModels(owner, keys, proxy)
		require.Error(t, err, proxy)
	}
	_, err := NewManagedModels(nil, keys, testProxyURL)
	require.Error(t, err)
	_, err = NewManagedModels(owner, nil, testProxyURL)
	require.Error(t, err)
}

type recordingLauncher struct {
	got  *Binding
	err  error
	used *bool
}

func (launcher recordingLauncher) LaunchChatHost(_ context.Context, _ ports.ChatTurnGrant, binding Binding) (Lease, error) {
	*launcher.used = true
	*launcher.got = binding
	return nil, launcher.err
}

func TestHostMintsTheTurnCredentialForAManagedBinding(t *testing.T) {
	var got Binding
	used := false
	stop := errors.New("stop after launch")
	managed := Binding{Model: json.RawMessage(`{}`), CredentialName: ManagedCredentialName, CredentialOrigin: "https://api.example.test", Managed: true}
	host, err := New(ownerResolving(managed, nil), recordingLauncher{got: &got, err: stop, used: &used})
	require.NoError(t, err)
	grant := ports.ChatTurnGrant{TurnID: "4b0f1c52-3a0e-4d53-9a55-1f1f7c3b8a10", OwnerID: 7, Generation: 3, Token: "producer-token"}
	require.ErrorIs(t, host.RunChatTurn(context.Background(), grant), stop)
	require.Equal(t, turncredential.Mint(grant.TurnID, grant.Generation, grant.Token), got.CredentialValue)
	require.NotContains(t, got.CredentialValue, grant.Token)

	// A model stream or model test has no durable turn to meter: it never
	// launches on managed credit.
	used = false
	var stream io.ReadCloser
	stream, err = host.RunModelStream(context.Background(), ports.ModelStreamGrant{OwnerID: 7, Request: json.RawMessage(`{}`)})
	require.Nil(t, stream)
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
	_, err = host.RunModelTest(context.Background(), 7, json.RawMessage(`{}`))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
	require.False(t, used)
}
