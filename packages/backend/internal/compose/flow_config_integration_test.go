package compose

import (
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Setup's actual HTTP admission and background worker must persist defaults
// before the person sees Source ready. This is process component evidence,
// not a real-microVM C-J1-06 receipt.
func TestInstallStoredConfigSourceReadyThroughRouter(t *testing.T) {
	for _, fixture := range []struct {
		name string
		argv [][]string
	}{
		{"node", [][]string{{"pnpm", "test"}, {"pnpm", "lint"}}},
		{"go", [][]string{{"go", "test", "./..."}}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			t.Setenv("REHEARSAL_CONFIG_FIXTURE", fixture.name)
			r := newRehearsal(t, "SMITHERS_FLW02_REHEARSAL", "C-J1-06", "flw02-")
			require.True(t, r.setupSource())
			var raw []byte
			require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT value FROM install_settings WHERE key=$1`, services.InstallCodingProjectKey).Scan(&raw))
			var project struct {
				Wiki     bool              `json:"wiki"`
				Seats    map[string]string `json:"seats"`
				Detected []struct {
					Argv []string `json:"argv"`
				} `json:"detected"`
				Pages []struct {
					ID string `json:"id"`
				} `json:"pages"`
			}
			require.NoError(t, json.Unmarshal(raw, &project))
			argv := [][]string{}
			for _, check := range project.Detected {
				argv = append(argv, check.Argv)
			}
			require.Equal(t, fixture.argv, argv)
			require.Equal(t, map[string]string{"coding/implement": "auto", "coding/plan": "auto", "coding/poc": "auto", "coding/review": "auto", "wiki/reviewer": "auto", "coding/dispatch": "auto", "repository/research": "auto", "repository/evaluator": "auto", "repository/author": "auto", "flow/author": "auto"}, project.Seats)
			require.True(t, project.Wiki)
			require.Len(t, project.Pages, 2)
			require.Equal(t, "overview", project.Pages[0].ID)
			require.Equal(t, "architecture", project.Pages[1].ID)
		})
	}
}
