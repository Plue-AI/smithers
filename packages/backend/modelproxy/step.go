package modelproxy

import (
	"net/http"
	"regexp"
)

var nativeStepID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var nativeExecutionID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)

// correlateCaller attaches bounded native coordinates after credential resolution.
// They cannot change the payer, binding, repository or workspace.
func correlateCaller(c Caller, h http.Header) Caller {
	if c.Source != SourceFlowHost && c.Source != SourceAgentRun {
		return c
	}
	if len(h.Values("X-Smithers-Execution-Id")) != 1 || len(h.Values("X-Smithers-Step-Id")) != 1 {
		return c
	}
	execution, step := h.Get("X-Smithers-Execution-Id"), h.Get("X-Smithers-Step-Id")
	if nativeExecutionID.MatchString(execution) && nativeStepID.MatchString(step) {
		c.ExecutionID, c.StepID = execution, step
	}
	return c
}
