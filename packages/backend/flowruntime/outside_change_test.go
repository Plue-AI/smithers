package flowruntime

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A published agent package must carry the same policy as the embedded backend
// artifact. This catches a policy change that forgot to regenerate the host.
func TestOutsideChangePolicyMatchesGeneratedHost(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("policy source path unavailable")
	}
	host := filepath.Join(filepath.Dir(source), "../../smithers/agent/src/OutsideChangePolicy.ts")
	artifact, err := os.ReadFile(host)
	if err != nil {
		t.Fatal(err)
	}
	expected := fmt.Sprintf("export const outsideChangeConsumerEnabled: boolean = %t\n", OutsideChangeConsumerEnabled())
	if !strings.HasSuffix(string(artifact), expected) {
		t.Fatal("host outside-change policy is stale; run go generate ./packages/backend/flowruntime")
	}
}

func TestOutsideChangePolicyFailsClosed(t *testing.T) {
	original := outsideChangePolicy
	t.Cleanup(func() { outsideChangePolicy = original })
	for _, tc := range []struct {
		policy  string
		enabled bool
	}{
		{`{"enabled":false}`, false}, {`{"enabled":true}`, true}, {`{}`, false}, {`{"enabled":"true"}`, false}, {`invalid`, false},
	} {
		t.Run(tc.policy, func(t *testing.T) {
			outsideChangePolicy = []byte(tc.policy)
			if got := OutsideChangeConsumerEnabled(); got != tc.enabled {
				t.Fatalf("enabled=%t; want %t", got, tc.enabled)
			}
		})
	}
}
