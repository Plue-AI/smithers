package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/cors"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"
)

// Validate against the committed released-client input contract, never a schema
// generated from the candidate backend or decoder during this test. Removing or
// changing this file requires a deliberate client compatibility decision.
func releasedAppBootstrapContract(t *testing.T) *jsonschema.Schema {
	t.Helper()
	path := filepath.Join("..", "..", "..", "rpc", "contracts", "app-bootstrap-v1.schema.json")
	schema, err := jsonschema.NewCompiler().Compile(path)
	require.NoError(t, err, "load the pinned released-client bootstrap contract")
	return schema
}

func bootstrapHTTPDocument(t *testing.T, features bootstrapFeatures) map[string]any {
	t.Helper()
	handler := withAppBootstrap(http.NotFoundHandler(), newAppBootstrap(features), cors.Options{})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil))
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, "application/json", response.Header().Get("Content-Type"))
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	var document map[string]any
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &document))
	return document
}

func TestAppBootstrapReleasedClientContract(t *testing.T) {
	schema := releasedAppBootstrapContract(t)
	// Auth and sandbox selection interact with identity, deployment topology,
	// redirect availability, runtime availability, and actual isolation.
	for _, hosted := range []bool{false, true} {
		for _, identity := range []bool{false, true} {
			for _, redirect := range []bool{false, true} {
				for _, runtime := range []bool{false, true} {
					for _, isolated := range []bool{false, true} {
						name := fmt.Sprintf("hosted=%t/identity=%t/redirect=%t/runtime=%t/isolated=%t", hosted, identity, redirect, runtime, isolated)
						t.Run(name, func(t *testing.T) {
							document := bootstrapHTTPDocument(t, bootstrapFeatures{
								role: topology{multitenant: hosted}, identity: identity, redirectAuth: redirect,
								workspaceRuntime: runtime, isolatedSandbox: isolated,
								// Exercise every advertised capability in each auth/sandbox shape.
								github: true, agent: true, modelTurn: true, recommend: true, workspace: true,
								terminal: true, billingBalance: true, billingOverview: true, billingPlans: true,
								billingPortal: true, billingCheckout: true,
							})
							require.NoError(t, schema.Validate(document), "backend bootstrap must remain readable by released v1 clients: %v", document)
						})
					}
				}
			}
		}
	}
	for _, tc := range []struct {
		name     string
		features bootstrapFeatures
	}{
		{"empty self-host", bootstrapFeatures{}},
		{"empty hosted", bootstrapFeatures{role: hostedAPITopology}},
		{"identity only", bootstrapFeatures{identity: true}},
		{"agent only", bootstrapFeatures{agent: true}},
		{"github only", bootstrapFeatures{github: true}},
		{"model turns only", bootstrapFeatures{modelTurn: true}},
		{"recommendations only", bootstrapFeatures{recommend: true}},
		{"workspace only", bootstrapFeatures{workspace: true}},
		{"terminal only", bootstrapFeatures{terminal: true}},
		{"balance only", bootstrapFeatures{billingBalance: true}},
		{"overview only", bootstrapFeatures{billingOverview: true}},
		{"plans only", bootstrapFeatures{billingPlans: true}},
		{"portal only", bootstrapFeatures{billingPortal: true}},
		{"checkout only", bootstrapFeatures{billingCheckout: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, schema.Validate(bootstrapHTTPDocument(t, tc.features)))
		})
	}
}

func TestAppBootstrapReleasedClientContractRejectsBreakingChanges(t *testing.T) {
	schema := releasedAppBootstrapContract(t)
	features := bootstrapFeatures{role: hostedAPITopology, identity: true, redirectAuth: true, agent: true, isolatedSandbox: true}
	// Start with the actual response so the mutations prove rejection at the
	// compatibility boundary, rather than merely testing unrelated JSON examples.
	require.NoError(t, schema.Validate(bootstrapHTTPDocument(t, features)))
	for _, field := range []string{"apiVersion", "host", "version", "buildSha", "capabilities", "authFlow", "sandbox"} {
		t.Run("missing "+field, func(t *testing.T) {
			document := bootstrapHTTPDocument(t, features)
			delete(document, field)
			var validation *jsonschema.ValidationError
			require.ErrorAs(t, schema.Validate(document), &validation)
		})
	}
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"new API version", func(d map[string]any) { d["apiVersion"] = float64(2) }},
		{"fractional API version", func(d map[string]any) { d["apiVersion"] = 1.5 }},
		{"string API version", func(d map[string]any) { d["apiVersion"] = "1" }},
		{"unknown host", func(d map[string]any) { d["host"] = "desktop" }},
		{"unknown auth flow", func(d map[string]any) { d["authFlow"] = "oauth-v2" }},
		{"nonstring version", func(d map[string]any) { d["version"] = float64(1) }},
		{"null build SHA", func(d map[string]any) { d["buildSha"] = nil }},
		{"null capabilities", func(d map[string]any) { d["capabilities"] = nil }},
		{"capabilities object", func(d map[string]any) { d["capabilities"] = map[string]any{"agent": true} }},
		{"mixed capability types", func(d map[string]any) { d["capabilities"] = []any{"agent", float64(1)} }},
		{"null capability", func(d map[string]any) { d["capabilities"] = []any{"agent", nil} }},
		{"boolean capability", func(d map[string]any) { d["capabilities"] = []any{true} }},
		{"object capability", func(d map[string]any) { d["capabilities"] = []any{map[string]any{"name": "agent"}} }},
		{"sandbox scalar", func(d map[string]any) { d["sandbox"] = "enforced" }},
		{"unknown sandbox mode", func(d map[string]any) { d["sandbox"].(map[string]any)["mode"] = "container" }},
		{"nonstring sandbox platform", func(d map[string]any) { d["sandbox"].(map[string]any)["platform"] = false }},
		{"missing sandbox platform", func(d map[string]any) { delete(d["sandbox"].(map[string]any), "platform") }},
		{"missing sandbox mode", func(d map[string]any) { delete(d["sandbox"].(map[string]any), "mode") }},
		{"null policies", func(d map[string]any) { d["sandbox"].(map[string]any)["policies"] = nil }},
		{"missing loader policy", func(d map[string]any) {
			d["sandbox"].(map[string]any)["policies"] = map[string]any{"targetRun": "unenforced"}
		}},
		{"missing target policy", func(d map[string]any) {
			d["sandbox"].(map[string]any)["policies"] = map[string]any{"loader": "enforced"}
		}},
		{"unknown loader policy", func(d map[string]any) {
			d["sandbox"].(map[string]any)["policies"] = map[string]any{"loader": "trusted-only", "targetRun": "unenforced"}
		}},
		{"unknown target policy", func(d map[string]any) {
			d["sandbox"].(map[string]any)["policies"] = map[string]any{"loader": "enforced", "targetRun": "trusted-only"}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			document := bootstrapHTTPDocument(t, features)
			tc.mutate(document)
			var validation *jsonschema.ValidationError
			require.ErrorAs(t, schema.Validate(document), &validation)
		})
	}
}

func TestAppBootstrapReleasedClientContractAllowsAdditiveChanges(t *testing.T) {
	schema := releasedAppBootstrapContract(t)
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"unknown string capability", func(d map[string]any) {
			d["capabilities"] = append(d["capabilities"].([]any), "future.workspace.capability")
		}},
		{"future fields", func(d map[string]any) {
			d["futureField"] = map[string]any{"enabled": true}
			d["sandbox"].(map[string]any)["futurePolicy"] = "enabled"
		}},
		{"local native host", func(d map[string]any) { d["host"] = "local"; d["authFlow"] = "native-handoff" }},
		{"both auth doors", func(d map[string]any) { d["authFlow"] = "both" }},
		{"unavailable sandbox", func(d map[string]any) { d["sandbox"].(map[string]any)["mode"] = "unavailable" }},
		{"sandbox policies", func(d map[string]any) {
			d["sandbox"].(map[string]any)["policies"] = map[string]any{"loader": "enforced", "targetRun": "unenforced"}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			document := bootstrapHTTPDocument(t, bootstrapFeatures{identity: true, agent: true, workspaceRuntime: true})
			tc.mutate(document)
			require.NoError(t, schema.Validate(document))
		})
	}
}
