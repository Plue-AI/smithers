package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func TestSignedApprovalBindsEveryRequiredCheckAndInstalledByte(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	revision := "0123456789012345678901234567890123456789"
	artifacts := map[string]string{gatewayArtifact: "a", supervisorArtifact: "b", installerArtifact: "c"}
	checks := []string{"C-SEC-02/R1", "C-SEC-02/R2", "C-SEC-02/R3", "C-SPK-08/root-prototype-install-validation", "C-SPK-08/root-session-input-validation"}
	approval := reviewApproval{"smithers-3f", revision, now.Add(time.Hour).Format(time.RFC3339), artifacts, checks}
	sign := func(payload []byte) []byte {
		signature := ed25519.Sign(private, append([]byte("smithers-trm06/review/v1\n"), payload...))
		body, _ := json.Marshal(signedApproval{payload, base64.StdEncoding.EncodeToString(signature)})
		return body
	}
	payload, _ := json.Marshal(approval)
	good := sign(payload)
	if err = verifyApproval(good, public, revision, artifacts, now); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"missing-check", "duplicate-check", "unknown-check", "wrong-reviewer", "expired", "wrong-revision", "replaced-binary", "duplicate-digest", "forged-signature"} {
		t.Run(scenario, func(t *testing.T) {
			candidate := approval
			candidate.Checks = append([]string(nil), checks...)
			body := good
			expected := artifacts
			switch scenario {
			case "missing-check":
				candidate.Checks = candidate.Checks[:4]
			case "duplicate-check":
				candidate.Checks = append(candidate.Checks, candidate.Checks[0])
			case "unknown-check":
				candidate.Checks[0] = "accepted"
			case "wrong-reviewer":
				candidate.Reviewer = "branch"
			case "expired":
				candidate.Expires = now.Format(time.RFC3339)
			case "wrong-revision":
				candidate.Revision = "ffffffffffffffffffffffffffffffffffffffff"
			case "replaced-binary":
				expected = map[string]string{gatewayArtifact: "poison", supervisorArtifact: "b", installerArtifact: "c"}
			case "duplicate-digest":
				body = sign([]byte(`{"reviewer":"smithers-3f","revision":"` + revision + `","expires":"2026-10-07T01:00:00Z","artifacts":{"bin/trm06-gateway":"poison","bin/trm06-gateway":"a"},"checks":[]}`))
			case "forged-signature":
				body = append([]byte(nil), good...)
				body[len(body)-5] ^= 1
			}
			if scenario != "duplicate-digest" && scenario != "forged-signature" {
				payload, _ := json.Marshal(candidate)
				body = sign(payload)
			}
			if verifyApproval(body, public, revision, expected, now) == nil {
				t.Fatal("accepted invalid authority")
			}
		})
	}
	if _, err := loadInstalledAuthority("/workspace/branch/gateway"); err == nil {
		t.Fatal("accepted branch executable")
	}
}
