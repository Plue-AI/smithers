package services

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestVerifyPKCE_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for length := 43; length <= 128; length++ {
		verifier := strings.Repeat("a", length)
		challenge := pkceChallengeForTest(verifier)

		caseCount++
		assert.Truef(t, verifyPKCE(challenge, "S256", verifier), "length=%d", length)
		assert.Falsef(t, verifyPKCE(challenge+"x", "S256", verifier), "length=%d", length)
		assert.Falsef(t, verifyPKCE(challenge, "plain", verifier), "length=%d", length)
	}

	tests := []struct {
		name      string
		challenge string
		method    string
		verifier  string
		want      bool
	}{
		{
			name:      "rfc7636_example",
			challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			method:    "S256",
			verifier:  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
			want:      true,
		},
		{
			name:      "case_sensitive_method",
			challenge: pkceChallengeForTest("verifier"),
			method:    "s256",
			verifier:  "verifier",
			want:      false,
		},
		{
			name:      "empty_challenge",
			challenge: "",
			method:    "S256",
			verifier:  "verifier",
			want:      false,
		},
		{
			name:      "empty_verifier",
			challenge: pkceChallengeForTest(""),
			method:    "S256",
			verifier:  "",
			want:      true,
		},
		{
			name:      "verifier_with_symbols",
			challenge: pkceChallengeForTest("abcXYZ-._~123"),
			method:    "S256",
			verifier:  "abcXYZ-._~123",
			want:      true,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, verifyPKCE(tc.challenge, tc.method, tc.verifier))
		})
	}

	assert.Equal(t, 86, caseCount)
}

func TestOAuth2Generators_FormatMatrix(t *testing.T) {
	t.Parallel()

	codes := map[string]struct{}{}
	tokens := map[string]struct{}{}

	caseCount := 0
	for i := 0; i < 64; i++ {
		code := generateOAuth2Code()
		require.Len(t, code, 64)
		assert.True(t, isLowerHexForTest(code))
		codes[code] = struct{}{}
		caseCount++

		token := generateOAuth2Token()
		require.Len(t, token, 64)
		assert.True(t, isLowerHexForTest(token))
		tokens[token] = struct{}{}
		caseCount++
	}

	assert.Len(t, codes, 64)
	assert.Len(t, tokens, 64)
	assert.Equal(t, 128, caseCount)
}

func TestHashOAuth2Secret_Deterministic(t *testing.T) {
	t.Parallel()

	secret := "smithers_oas_deadbeef"
	want := sha256.Sum256([]byte(secret))

	assert.Equal(t, hex.EncodeToString(want[:]), hashOAuth2Secret(secret))
	assert.Equal(t, hashOAuth2Secret(secret), hashOAuth2Secret(secret))
	assert.NotEqual(t, hashOAuth2Secret(secret), hashOAuth2Secret(secret+"x"))
}

func pkceChallengeForTest(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func isLowerHexForTest(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}
