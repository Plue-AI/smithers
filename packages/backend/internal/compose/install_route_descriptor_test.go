package compose

import (
	"context"
	"github.com/stretchr/testify/require"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Enumeration catches catalog removals that leave already mapped HTTP doors
// refusing every credential. Unmapped route coverage is a separate audit; this
// test makes no claim that the route-to-command migration is complete.
func TestMappedInstallRoutesHaveCatalogDescriptors(t *testing.T) {
	parameters := regexp.MustCompile(`\{[^}]+\}`)
	for _, route := range servedCompositionRoutes(t, config.AuthModeSelfHosted) {
		path := strings.ReplaceAll(route.path, "{operation}", "candidate")
		for _, name := range []string{"{keyDigest}", "{digest}", "{log_digest}"} {
			path = strings.ReplaceAll(path, name, strings.Repeat("a", 64))
		}
		path = parameters.ReplaceAllString(path, "1")
		command := middleware.InstallMemberCommand(strings.ToUpper(route.method), path)
		switch command {
		case "", "public", "self":
			continue
		case "denied":
			// Explicitly unavailable legacy doors grant no authority. This is
			// a refusal binding, never an operation that can acquire actors.
			_, exists := services.OperationPolicy(command)
			require.False(t, exists, "a refusal binding cannot become a command")
			_, err := services.Authorize(context.Background(), nil, command)
			var refusal *services.AccessError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, http.StatusForbidden, refusal.Status)
			require.Equal(t, "permission", refusal.Code)
			continue
		// These adapters resolve a concrete command from the body before Authorize.
		case "flow.relay", "branch.control", "todo.control", "approval.decide":
			continue
		// Existing legacy names have explicit aliases in installCommandPolicy.
		case "members.write":
			command = "members.add"
		case "secrets.write":
			command = "secrets.set"
		case "branch.join":
			command = "branch"
		}
		if _, ok := services.OperationPolicy(command); !ok {
			t.Errorf("%s %s resolves absent catalog operation %q", route.method, route.path, command)
		}
	}
}
