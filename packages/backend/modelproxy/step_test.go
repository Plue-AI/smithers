package modelproxy

import (
	"github.com/stretchr/testify/require"
	"net/http"
	"strings"
	"testing"
)

func TestStepCorrelationDoesNotGrantAuthority(t *testing.T) {
	h := http.Header{}
	h.Set("X-Smithers-Execution-Id", "exec-1")
	h.Set("X-Smithers-Step-Id", strings.Repeat("a", 64))
	for _, source := range []string{SourceFlowHost, SourceAgentRun, SourceApp, SourceWorkspace} {
		caller := Caller{OwnerType: "user", OwnerID: 7, RepositoryID: 3, WorkspaceID: "w", Reference: "binding", Source: source}
		got := correlateCaller(caller, h)
		if source == SourceFlowHost || source == SourceAgentRun {
			require.Equal(t, "exec-1", got.ExecutionID)
			require.Equal(t, strings.Repeat("a", 64), got.StepID)
		} else {
			require.Empty(t, got.ExecutionID)
			require.Empty(t, got.StepID)
		}
		got.ExecutionID, got.StepID = "", ""
		require.Equal(t, caller, got)
	}
	h.Add("X-Smithers-Step-Id", strings.Repeat("b", 64))
	require.Empty(t, correlateCaller(Caller{Source: SourceFlowHost}, h).StepID, "duplicate header is ambiguous")
	h.Del("X-Smithers-Step-Id")

	for _, values := range [][2]string{{"", strings.Repeat("a", 64)}, {"exec", "bad"}, {" exec", strings.Repeat("a", 64)}, {strings.Repeat("x", 257), strings.Repeat("a", 64)}, {"exec", strings.Repeat("a", 65)}} {
		h.Set("X-Smithers-Execution-Id", values[0])
		h.Set("X-Smithers-Step-Id", values[1])
		require.Empty(t, correlateCaller(Caller{Source: SourceFlowHost}, h).StepID)
	}
}

func FuzzStepCorrelation(f *testing.F) {
	f.Add("exec", strings.Repeat("a", 64))
	f.Add("bad\nheader", "a")
	f.Fuzz(func(t *testing.T, execution, step string) {
		h := http.Header{"X-Smithers-Execution-Id": {execution}, "X-Smithers-Step-Id": {step}}
		caller := Caller{OwnerID: 7, RepositoryID: 9, WorkspaceID: "authorized", Source: SourceFlowHost}
		got := correlateCaller(caller, h)
		require.Equal(t, caller.OwnerID, got.OwnerID)
		require.Equal(t, caller.RepositoryID, got.RepositoryID)
		require.Equal(t, caller.WorkspaceID, got.WorkspaceID)
		if got.StepID != "" {
			require.Len(t, got.StepID, 64)
			require.LessOrEqual(t, len(got.ExecutionID), 256)
			require.True(t, nativeExecutionID.MatchString(got.ExecutionID))
			require.True(t, nativeStepID.MatchString(got.StepID))
		}
	})
}
