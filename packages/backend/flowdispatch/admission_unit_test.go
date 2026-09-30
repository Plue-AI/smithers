package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
	"github.com/stretchr/testify/require"
)

func unitLaunch() LaunchRequest {
	return LaunchRequest{
		Scope: jobs.Scope{TenantID: "repository:1", PrincipalID: "user:2"}, RequestID: "request-3", FlowID: "setup",
		Target:  flowruntime.Target{WorkspaceID: "workspace-4", BindingKind: "repository", BindingID: "owner/repo"},
		Payload: json.RawMessage(`{"text":"hello","enabled":true}`), AuthorizationContext: json.RawMessage(`{"role":"writer"}`),
	}
}

func TestLaunchAdmissionUnitPolicyAndScopeInheritance(t *testing.T) {
	for _, targetScope := range []struct{ name, tenant, principal string }{
		{"both inherited", "", ""}, {"tenant inherited", "", "user:2"},
		{"principal inherited", "repository:1", ""}, {"both explicit", "repository:1", "user:2"},
	} {
		for _, policy := range []struct {
			value    ApprovalPolicy
			expected string
		}{
			{"", "manual"}, {"manual", "manual"}, {"approve", "approve"},
		} {
			t.Run(targetScope.name+"/"+policy.expected+"/"+string(policy.value), func(t *testing.T) {
				input := unitLaunch()
				input.Target.TenantID, input.Target.PrincipalID = targetScope.tenant, targetScope.principal
				input.ApprovalPolicy = policy.value
				admitted, err := launchAdmission(input)
				require.NoError(t, err)
				require.Equal(t, input.Scope, admitted.Scope)
				require.Equal(t, "request-3", admitted.RequestID)
				require.Equal(t, "flow.runtime.launch", admitted.Operation)
				require.Equal(t, jobs.EffectPolicy("reconcile"), admitted.EffectPolicy)
				require.Equal(t, "flow-runtime:request-3", admitted.EffectKey)
				require.Equal(t, json.RawMessage(`{"role":"writer"}`), admitted.AuthorizationContext)
				require.JSONEq(t, `{"target":{"TenantID":"repository:1","PrincipalID":"user:2","WorkspaceID":"workspace-4","BindingKind":"repository","BindingID":"owner/repo"},"flowId":"setup","payload":{"text":"hello","enabled":true},"projection":{},"approvalPolicy":"`+policy.expected+`"}`, string(admitted.Payload))
				require.Equal(t, targetScope.tenant, input.Target.TenantID, "admission does not mutate caller input")
				require.Equal(t, targetScope.principal, input.Target.PrincipalID)
			})
		}
	}
	input := unitLaunch()
	input.Projection = json.RawMessage(`{"correlation":"product-only"}`)
	input.Payload = nil
	admitted, err := launchAdmission(input)
	require.NoError(t, err)
	var payload map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(admitted.Payload, &payload))
	require.JSONEq(t, `{"correlation":"product-only"}`, string(payload["projection"]))
	require.Equal(t, "null", string(payload["payload"]))
}

func TestLaunchAdmissionUnitRefusesBeforeDurableWork(t *testing.T) {
	cases := []struct {
		name    string
		edit    func(*LaunchRequest)
		message string
	}{
		{"missing request", func(r *LaunchRequest) { r.RequestID = " \t" }, "flow dispatch: request ID and flow ID are required"},
		{"missing flow", func(r *LaunchRequest) { r.FlowID = "\n" }, "flow dispatch: request ID and flow ID are required"},
		{"wrong tenant", func(r *LaunchRequest) { r.Target.TenantID = "repository:other" }, "flow dispatch: runtime target is outside the admitted scope"},
		{"wrong principal", func(r *LaunchRequest) { r.Target.PrincipalID = "user:other" }, "flow dispatch: runtime target is outside the admitted scope"},
		{"missing kind", func(r *LaunchRequest) { r.Target.BindingKind = " " }, "flow dispatch: runtime target binding is required"},
		{"missing binding", func(r *LaunchRequest) { r.Target.BindingID = "\t" }, "flow dispatch: runtime target binding is required"},
		{"unknown approval", func(r *LaunchRequest) { r.ApprovalPolicy = "auto" }, "flow dispatch: invalid approval policy"},
	}
	// No store or runtime is present: every refused input must return before
	// durable admission or external dispatch, rather than dereferencing either.
	service := &Service{}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			input := unitLaunch()
			item.edit(&input)
			admission, err := launchAdmission(input)
			require.EqualError(t, err, item.message)
			require.Equal(t, jobs.Admission{}, admission)
			receipt, err := service.Admit(context.Background(), input)
			require.EqualError(t, err, item.message)
			require.Equal(t, jobs.RequestReceipt{}, receipt)
		})
	}
	for _, side := range []string{"payload", "projection"} {
		t.Run("malformed "+side, func(t *testing.T) {
			input := unitLaunch()
			if side == "payload" {
				input.Payload = json.RawMessage(`{`)
			} else {
				input.Projection = json.RawMessage(`{`)
			}
			receipt, err := service.Admit(context.Background(), input)
			require.ErrorContains(t, err, "flow dispatch: encode launch: json: error calling MarshalJSON")
			require.Equal(t, jobs.RequestReceipt{}, receipt)
		})
	}
	receipt, err := service.AdmitInTx(context.Background(), nil, LaunchRequest{})
	require.EqualError(t, err, "flow dispatch: transaction is required")
	require.Equal(t, jobs.RequestReceipt{}, receipt)
}

func TestDispatchConstructorUnitBoundsAndRequirements(t *testing.T) {
	_, err := New(Config{})
	require.EqualError(t, err, "flow dispatch: jobs store is required")
	_, err = New(Config{Store: &jobs.Store{}})
	require.EqualError(t, err, "flow dispatch: runtime resolver is required")
	resolver := flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Fatal("constructing or calculating backoff must not resolve a runtime")
		return nil, errors.New("unexpected resolution")
	})
	for _, item := range []struct {
		name                         string
		limit, pages                 int
		timeout                      time.Duration
		expectedLimit, expectedPages int
		expectedTimeout              time.Duration
	}{
		{"defaults", 0, 0, 0, 250, 4, 30 * time.Second},
		{"negative", -1, -1, -time.Second, 250, 4, 30 * time.Second},
		{"minimum", 1, 1, time.Nanosecond, 1, 1, time.Nanosecond},
		{"maximum limit", 1000, 8, time.Minute, 1000, 8, time.Minute},
		{"over maximum limit", 1001, 8, time.Minute, 250, 8, time.Minute},
	} {
		t.Run(item.name, func(t *testing.T) {
			service, err := New(Config{Store: &jobs.Store{}, Resolver: resolver, ObservationLimit: item.limit, ObservationPages: item.pages, RuntimeCallTimeout: item.timeout})
			require.NoError(t, err)
			require.Equal(t, item.expectedLimit, service.observationLimit)
			require.Equal(t, item.expectedPages, service.observationPages)
			require.Equal(t, item.expectedTimeout, service.runtimeCallTimeout)
			require.Equal(t, time.Second, service.observationBackoff(0))
			require.Equal(t, 30*time.Second, service.observationBackoff(50))
		})
	}
}

func TestDispatchUnitBackoffSaturatesAndProgressResets(t *testing.T) {
	resolver := flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, errors.New("unused")
	})
	service, err := New(Config{Store: &jobs.Store{}, Resolver: resolver, ObservationDelay: 5 * time.Second, MaxObservationDelay: 12 * time.Second})
	require.NoError(t, err)
	checkpoint := RuntimeCheckpoint{}
	require.Equal(t, 10*time.Second, service.nextObservation(&checkpoint, false))
	require.Equal(t, 1, checkpoint.IdlePolls)
	require.Equal(t, 12*time.Second, service.nextObservation(&checkpoint, false))
	require.Equal(t, 2, checkpoint.IdlePolls)
	require.Equal(t, 12*time.Second, service.nextObservation(&checkpoint, false))
	require.Equal(t, 2, checkpoint.IdlePolls, "saturated polling does not keep changing durable state")
	require.Equal(t, 5*time.Second, service.nextObservation(&checkpoint, true))
	require.Zero(t, checkpoint.IdlePolls)
	require.Equal(t, 12*time.Second, service.observationBackoff(1_000_000_000), "idle history stops iterating once capped")
	clamped, err := New(Config{Store: &jobs.Store{}, Resolver: resolver, ObservationDelay: 5 * time.Second, MaxObservationDelay: time.Second})
	require.NoError(t, err)
	require.Equal(t, 5*time.Second, clamped.nextObservation(&checkpoint, false))
	require.Zero(t, checkpoint.IdlePolls)
}

func TestDispatchUnitBackoffDoesNotWrapLargePositiveDuration(t *testing.T) {
	resolver := flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, errors.New("unused")
	})
	for _, item := range []struct {
		name           string
		delay, maximum time.Duration
		waits          []time.Duration
		idle           []int
	}{
		{"odd cap floor half", 3, 7, []time.Duration{6, 7, 7}, []int{1, 2, 2}},
		{"odd cap ceil half", 4, 7, []time.Duration{7, 7, 7}, []int{1, 1, 1}},
		{"even cap exact half", 4, 8, []time.Duration{8, 8, 8}, []int{1, 1, 1}},
		{"just below half of duration maximum", 4611686018427387903, 9223372036854775807,
			[]time.Duration{9223372036854775806, 9223372036854775807, 9223372036854775807}, []int{1, 2, 2}},
		{"first doubling overflows", 4611686018427387904, 9223372036854775807,
			[]time.Duration{9223372036854775807, 9223372036854775807, 9223372036854775807}, []int{1, 1, 1}},
		{"already at maximum", 9223372036854775807, 9223372036854775807,
			[]time.Duration{9223372036854775807, 9223372036854775807, 9223372036854775807}, []int{0, 0, 0}},
		{"configured maximum below integer maximum", 4000000000000000000, 6000000000000000000,
			[]time.Duration{6000000000000000000, 6000000000000000000, 6000000000000000000}, []int{1, 1, 1}},
	} {
		t.Run(item.name, func(t *testing.T) {
			service, err := New(Config{Store: &jobs.Store{}, Resolver: resolver,
				ObservationDelay: item.delay, MaxObservationDelay: item.maximum})
			require.NoError(t, err)
			checkpoint := RuntimeCheckpoint{}
			for step, expected := range item.waits {
				wait := service.nextObservation(&checkpoint, false)
				require.Positive(t, wait, "a valid idle poll must not become immediately eligible")
				require.Equal(t, expected, wait, "poll %d", step)
				require.Equal(t, item.idle[step], checkpoint.IdlePolls, "poll %d", step)
			}
			require.Equal(t, item.delay, service.nextObservation(&checkpoint, true))
			require.Zero(t, checkpoint.IdlePolls)
		})
	}
}

func TestDispatchUnitCheckpointAdmission(t *testing.T) {
	checkpoint, err := decodeCheckpoint(nil)
	require.NoError(t, err)
	require.Equal(t, RuntimeCheckpoint{}, checkpoint)
	for _, raw := range []string{"{", "[]", "true", "42", `{"version":"1"}`} {
		value, err := decodeCheckpoint(json.RawMessage(raw))
		require.EqualError(t, err, "flow dispatch: invalid durable runtime checkpoint", raw)
		require.Equal(t, RuntimeCheckpoint{}, value)
	}
	for _, raw := range []string{"null", "{}", `{"version":0}`, `{"version":2}`} {
		value, err := decodeCheckpoint(json.RawMessage(raw))
		require.EqualError(t, err, "flow dispatch: unsupported durable runtime checkpoint", raw)
		require.Equal(t, RuntimeCheckpoint{}, value)
	}
	checkpoint, err = decodeCheckpoint(json.RawMessage(`{"version":1,"flowId":"setup","runId":"run-1","projection":{"product":"only"}}`))
	require.NoError(t, err)
	require.Equal(t, 1, checkpoint.Version)
	require.Equal(t, "setup", checkpoint.FlowID)
	require.Equal(t, "run-1", checkpoint.RunID)
	require.JSONEq(t, `{"product":"only"}`, string(checkpoint.Projection))
}

func TestSignalAdmissionUnitRefusesBeforeDurableWork(t *testing.T) {
	valid := func() SignalRequest {
		launch := unitLaunch()
		return SignalRequest{Scope: launch.Scope, Target: launch.Target, RequestID: "signal-1", FlowID: "setup", RunID: "run-2", Name: "continue", Payload: json.RawMessage(`{"allow":true}`)}
	}
	cases := []struct {
		name    string
		edit    func(*SignalRequest)
		message string
	}{
		{"missing request", func(r *SignalRequest) { r.RequestID = " " }, "flow dispatch: signal request, flow, run, and name are required"},
		{"missing flow", func(r *SignalRequest) { r.FlowID = "\t" }, "flow dispatch: signal request, flow, run, and name are required"},
		{"missing run", func(r *SignalRequest) { r.RunID = "\n" }, "flow dispatch: signal request, flow, run, and name are required"},
		{"missing name", func(r *SignalRequest) { r.Name = " " }, "flow dispatch: signal request, flow, run, and name are required"},
		{"wrong tenant", func(r *SignalRequest) { r.Target.TenantID = "other" }, "flow dispatch: runtime target is outside the admitted scope"},
		{"wrong principal", func(r *SignalRequest) { r.Target.PrincipalID = "other" }, "flow dispatch: runtime target is outside the admitted scope"},
		{"missing kind", func(r *SignalRequest) { r.Target.BindingKind = " " }, "flow dispatch: runtime target binding is required"},
		{"missing binding", func(r *SignalRequest) { r.Target.BindingID = " " }, "flow dispatch: runtime target binding is required"},
	}
	service := &Service{}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			input := valid()
			item.edit(&input)
			receipt, err := service.Signal(context.Background(), input)
			require.EqualError(t, err, item.message)
			require.Equal(t, jobs.RequestReceipt{}, receipt)
		})
	}
	for _, field := range []string{"payload", "projection"} {
		t.Run("malformed "+field, func(t *testing.T) {
			input := valid()
			if field == "payload" {
				input.Payload = json.RawMessage(`{`)
			} else {
				input.Projection = json.RawMessage(`{`)
			}
			receipt, err := service.Signal(context.Background(), input)
			require.ErrorContains(t, err, "flow dispatch: encode signal: json: error calling MarshalJSON")
			require.Equal(t, jobs.RequestReceipt{}, receipt)
		})
	}
}

func TestPreRunRuntimeFailurePreservesAuthoritativeRefusals(t *testing.T) {
	for _, refusal := range []string{"http_refused", "health_refused"} {
		for _, tc := range []struct {
			status int
			runID  string
			retry  bool
		}{
			{404, "", true}, {404, "run", false}, {400, "", false}, {401, "", false},
			{403, "", false}, {409, "", false}, {500, "", true}, {503, "", true},
		} {
			t.Run(fmt.Sprintf("%s/%d/%s", refusal, tc.status, tc.runID), func(t *testing.T) {
				failure := &runtimebridge.Error{Code: refusal, HTTPStatus: tc.status, Retryable: tc.status >= 500, Message: "private provider details"}
				code, retry := preRunRuntimeFailure(fmt.Errorf("wrapped: %w", failure), tc.runID)
				require.Equal(t, refusal, code)
				require.Equal(t, tc.retry, retry)
			})
		}
	}
	code, retry := preRunRuntimeFailure(safeFailure{code: "http_refused"}, "")
	require.Equal(t, "http_refused", code)
	require.False(t, retry, "an untyped refusal is not evidence of a bare HTTP 404")
	_, retry = preRunRuntimeFailure(safeFailure{code: "host_lease_lost"}, "")
	require.True(t, retry)
	_, retry = preRunRuntimeFailure(safeFailure{code: "host_lease_lost"}, "run")
	require.False(t, retry)
}
