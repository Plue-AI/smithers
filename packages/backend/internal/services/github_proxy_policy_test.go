package services

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestEvaluateGitHubProxyPolicy(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		input       GitHubProxyPolicyInput
		wantAllowed bool
		wantReason  string
	}{
		{
			name: "allows GET contents",
			input: GitHubProxyPolicyInput{
				Method:    "GET",
				Path:      "/repos/acme/demo/contents/.smithers/workflow.yaml",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: true,
			wantReason:  "contents read allowed",
		},
		{
			name: "allows POST issue comments",
			input: GitHubProxyPolicyInput{
				Method:    "POST",
				Path:      "/repos/acme/demo/issues/44/comments",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: true,
			wantReason:  "comment creation allowed",
		},
		{
			name: "allows GET pull metadata",
			input: GitHubProxyPolicyInput{
				Method:    "GET",
				Path:      "/repos/acme/demo/pulls/44",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: true,
			wantReason:  "metadata read allowed",
		},
		{
			name: "denies pull request merge",
			input: GitHubProxyPolicyInput{
				Method:    "PUT",
				Path:      "/repos/acme/demo/pulls/44/merge",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: false,
			wantReason:  gitHubProxyReasonMergeDenied,
		},
		{
			name: "allows pull request merge for authenticated stack proxy",
			input: GitHubProxyPolicyInput{
				Method:      "PUT",
				Path:        "/repos/acme/demo/pulls/44/merge",
				RepoOwner:   "acme",
				RepoName:    "demo",
				AllowMerges: true,
			},
			wantAllowed: true,
			wantReason:  "pull request merge allowed",
		},
		{
			name: "denies pull creation",
			input: GitHubProxyPolicyInput{
				Method:    "POST",
				Path:      "/repos/acme/demo/pulls",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: false,
			wantReason:  gitHubProxyReasonPullWriteDenied,
		},
		{
			name: "allows pull creation for authenticated stack proxy",
			input: GitHubProxyPolicyInput{
				Method:          "POST",
				Path:            "/repos/acme/demo/pulls",
				RepoOwner:       "acme",
				RepoName:        "demo",
				AllowPullWrites: true,
			},
			wantAllowed: true,
			wantReason:  "pull request creation allowed",
		},
		{
			name: "denies pull updates",
			input: GitHubProxyPolicyInput{
				Method:    "PATCH",
				Path:      "/repos/acme/demo/pulls/44",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: false,
			wantReason:  gitHubProxyReasonPullWriteDenied,
		},
		{
			name: "allows pull updates for authenticated stack proxy",
			input: GitHubProxyPolicyInput{
				Method:          "PATCH",
				Path:            "/repos/acme/demo/pulls/44",
				RepoOwner:       "acme",
				RepoName:        "demo",
				AllowPullWrites: true,
			},
			wantAllowed: true,
			wantReason:  "pull request update allowed",
		},
		{
			name: "denies deleting branches",
			input: GitHubProxyPolicyInput{
				Method:    "DELETE",
				Path:      "/repos/acme/demo/git/refs/heads/main",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: false,
			wantReason:  gitHubProxyReasonDeleteBranchDenied,
		},
		{
			name: "allows deleting smithers branches for authenticated stack proxy",
			input: GitHubProxyPolicyInput{
				Method:             "DELETE",
				Path:               "/repos/acme/demo/git/refs/heads/smithers/run-123",
				RepoOwner:          "acme",
				RepoName:           "demo",
				AllowBranchDeletes: true,
			},
			wantAllowed: true,
			wantReason:  "git ref delete allowed",
		},
		{
			name: "allows pushing smithers branch",
			input: GitHubProxyPolicyInput{
				Method:    "POST",
				Path:      "/repos/acme/demo/git/refs",
				Body:      json.RawMessage(`{"ref":"refs/heads/smithers/run-123","sha":"deadbeef"}`),
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: true,
			wantReason:  "git ref write allowed",
		},
		{
			name: "denies pushing non smithers branch",
			input: GitHubProxyPolicyInput{
				Method:    "POST",
				Path:      "/repos/acme/demo/git/refs",
				Body:      json.RawMessage(`{"ref":"refs/heads/main","sha":"deadbeef"}`),
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: false,
			wantReason:  gitHubProxyReasonPushBranchDenied,
		},
		{
			name: "allows patching smithers branch",
			input: GitHubProxyPolicyInput{
				Method:    "PATCH",
				Path:      "/repos/acme/demo/git/refs/heads/smithers/run-123",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: true,
			wantReason:  "git ref write allowed",
		},
		{
			name: "denies patching non smithers branch",
			input: GitHubProxyPolicyInput{
				Method:    "PATCH",
				Path:      "/repos/acme/demo/git/refs/heads/main",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: false,
			wantReason:  gitHubProxyReasonPushBranchDenied,
		},
		{
			name: "denies repository mismatch",
			input: GitHubProxyPolicyInput{
				Method:    "GET",
				Path:      "/repos/other/demo/contents/README.md",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: false,
			wantReason:  gitHubProxyReasonRepositoryMismatch,
		},
		{
			name: "denies unknown action",
			input: GitHubProxyPolicyInput{
				Method:    "POST",
				Path:      "/repos/acme/demo/releases",
				RepoOwner: "acme",
				RepoName:  "demo",
			},
			wantAllowed: false,
			wantReason:  gitHubProxyReasonDefaultDenied,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := EvaluateGitHubProxyPolicy(tt.input)
			assert.Equal(t, tt.wantAllowed, got.Allowed)
			assert.Equal(t, tt.wantReason, got.Reason)
		})
	}
}
