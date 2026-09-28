package credentialscan

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestScanRecognizesEveryCredentialFamilyWithoutExposingMatches(t *testing.T) {
	for _, tc := range []struct {
		rule      string
		hint      string
		literal   string
		secretRHS string
	}{
		{rule: "pem_private_key", hint: "a PEM private key block", literal: "-----BEGIN RSA PRIVATE KEY-----"},
		{rule: "github_token", hint: "a GitHub token", literal: "ghp_" + strings.Repeat("A", 16)},
		{rule: "anthropic_api_key", hint: "an Anthropic API key", literal: "sk-ant-" + strings.Repeat("B", 16)},
		{rule: "openai_api_key", hint: "an OpenAI API key", literal: "sk-proj-" + strings.Repeat("C", 32)},
		{rule: "aws_access_key_id", hint: "an AWS access key id", literal: "AKIA" + strings.Repeat("D", 16)},
		{rule: "slack_token", hint: "a Slack token", literal: "xoxb-" + strings.Repeat("E", 10)},
		{rule: "google_api_key", hint: "a Google API key", literal: "AIza" + strings.Repeat("F", 35)},
		{rule: "stripe_secret_key", hint: "a Stripe secret key", literal: "sk_test_" + strings.Repeat("G", 16)},
		{rule: "sendgrid_api_key", hint: "a SendGrid API key", literal: "SG." + strings.Repeat("H", 16) + "." + strings.Repeat("I", 16)},
		{rule: "gitlab_token", hint: "a GitLab token", literal: "glpat-" + strings.Repeat("J", 16)},
		{rule: "npm_token", hint: "an npm token", literal: "npm_" + strings.Repeat("K", 30)},
		{rule: "notion_token", hint: "a Notion integration token", literal: "ntn_" + strings.Repeat("L", 30)},
		{rule: "smithers_token", hint: "a Smithers token", literal: "smithers_oat_" + strings.Repeat("M", 32)},
		{rule: "bearer_literal", hint: "a literal bearer token", literal: "Bearer " + strings.Repeat("N", 20), secretRHS: strings.Repeat("N", 20)},
		{rule: "jwt", hint: "a JSON Web Token", literal: "eyJ" + strings.Repeat("O", 8) + "." + strings.Repeat("P", 8) + "." + strings.Repeat("Q", 8)},
		{rule: "credential_assignment", hint: "a credential-looking value assigned to a secret-named field", literal: "password=Z9y8X7w6V5u4T3s2R1q0", secretRHS: "Z9y8X7w6V5u4T3s2R1q0"},
	} {
		t.Run(tc.rule, func(t *testing.T) {
			finding := ScanForCredentialMaterial("safe line\n" + tc.literal)
			if finding == nil || finding.Rule != tc.rule || finding.Line != 2 || finding.Hint != tc.hint {
				t.Fatalf("finding=%+v, want rule %s, hint %q on line 2", finding, tc.rule, tc.hint)
			}
			encoded, err := json.Marshal(finding)
			if err != nil {
				t.Fatal(err)
			}
			want := `{"rule":"` + tc.rule + `","hint":"` + tc.hint + `","line":2}`
			if string(encoded) != want || strings.Contains(string(encoded), tc.literal) ||
				(tc.secretRHS != "" && strings.Contains(string(encoded), tc.secretRHS)) {
				t.Fatalf("unsafe or unexpected finding: got %s, want %s", encoded, want)
			}
		})
	}
}

func TestGenericAssignmentsRespectLengthReferencesAndEntropy(t *testing.T) {
	for _, value := range []string{
		"AbC0123!xyz7890", // below the 16-character threshold
		"${ALPHANUMERIC_SECRET_SOURCE}",
		"process.env.PROVIDER_SECRET",
		"op://Team/Item/Credential",
		"connectors.github.token",
		"your-production-token",
		"XXXXXXXXXXXXXXXXXXXX",
		"!A9b8C7d6E5f4G3h2I1j0",
		"&A9b8C7d6E5f4G3h2I1j0",
		"<A9b8C7d6E5f4G3h2I1j0",
		"$A9b8C7d6E5f4G3h2I1j0",
	} {
		if looksLikeSecretValue(value) {
			t.Errorf("reference or placeholder accepted: %q", value)
		}
	}
	for _, value := range []string{"A9b8C7d6E5f4G3h2I1j0", "u9N4mK8pR2xV7qL5cB3jH6sT1wZ0dF4a"} {
		if !looksLikeSecretValue(value) {
			t.Errorf("synthetic high-entropy value refused: %q", value)
		}
	}
	if got := shannonEntropy(""); got != 0 {
		t.Fatalf("empty text entropy=%v, want 0", got)
	}
	if got := shannonEntropy("aaaaaaaaaaaaaaaa"); got != 0 {
		t.Fatalf("uniform text entropy=%v, want 0", got)
	}
	if got := shannonEntropy("abababababababab"); got != 1 {
		t.Fatalf("two equally frequent characters entropy=%v, want 1", got)
	}
}
