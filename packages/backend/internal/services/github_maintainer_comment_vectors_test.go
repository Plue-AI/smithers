package services

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// maintainerCommentVector is one case of the shared maintainer-comment rule
// in docs/api/github-maintainer-comment.vectors.json, which the review Action
// runs too.
type maintainerCommentVector struct {
	Name        string         `json:"name"`
	Action      string         `json:"action"`
	Author      gitHubActor    `json:"author"`
	Sender      *gitHubActor   `json:"sender"`
	ViaApp      bool           `json:"viaApp"`
	Changes     []string       `json:"changes"`
	Permissions map[string]any `json:"permissions"`
	Expect      string         `json:"expect"`
}

func TestGitHubMaintainerCommentVectors(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "api", "github-maintainer-comment.vectors.json"))
	require.NoError(t, err)
	var spec struct {
		Description string                    `json:"description"`
		Vectors     []maintainerCommentVector `json:"vectors"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	require.NoError(t, decoder.Decode(&spec))
	require.NotEmpty(t, spec.Vectors)
	for _, vector := range spec.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			t.Parallel()
			require.Contains(t, []string{"maintainer", "not", "unavailable"}, vector.Expect)
			fake, stamper := newFakeIssueTextGitHub(t)
			fake.permissions, fake.permissionStatus = map[string]string{}, map[string]int{}
			for login, answer := range vector.Permissions {
				switch value := answer.(type) {
				case string:
					fake.permissions[login] = value
				case float64:
					fake.permissionStatus[login] = int(value)
				case nil:
					fake.permissionStatus[login] = permissionConnectionFails
				default:
					t.Fatalf("permission for %s is neither a permission nor a status: %v", login, answer)
				}
			}
			changes := map[string]any{}
			for _, part := range vector.Changes {
				changes[part] = map[string]string{"from": "earlier " + part}
			}
			// Only the comment: a real event's issue is stamped too, from its
			// own writers, and is not this rule's.
			comment := map[string]any{"id": 51, "body": "@smithers review", "user": vector.Author, "performed_via_github_app": nil}
			if vector.ViaApp {
				comment["performed_via_github_app"] = map[string]any{"id": 1, "slug": "some-app"}
			}
			payload, err := json.Marshal(map[string]any{
				"action": vector.Action, "installation": map[string]any{"id": 777}, "changes": changes, "sender": vector.Sender,
				"repository": map[string]any{"id": 9001, "name": "demo", "owner": map[string]string{"login": "Acme"}},
				"comment":    comment,
			})
			require.NoError(t, err)

			stamped, err := stamper.stampGitHubText(context.Background(), "issue_comment", vector.Action, payload)
			if vector.Expect == "unavailable" {
				require.ErrorIs(t, err, errGitHubIssueTextUnavailable)
				return
			}
			require.NoError(t, err)
			var event struct {
				Comment map[string]any `json:"comment"`
			}
			require.NoError(t, json.Unmarshal(stamped, &event))
			assert.Equal(t, vector.Expect == "maintainer", event.Comment[issueTextByMaintainerField], vector.Expect)
		})
	}
}
