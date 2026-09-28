package webhook

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Fixed vectors computed independently with Python's hmac/sha256. Neither
// production signing nor verification supplies the expected digest at runtime.
func TestDeliveryContract_SignatureVectors(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, secret, payload, digest string
	}{
		{"json", "hook-secret", `{"event":"ping"}`, "2083f94244aa333f17324ede37c65d60c128331cc1bc5e5873b2bab633b2087c"},
		{"opaque bytes", "  clé 🔑\t", "\x00\xff\r\n😀", "40d4d3183c5ca88f6951f0e2f19577b4023f3ccd88d20ab3d50b43a8eee900d0"},
		{"empty payload", "secret", "", "f9e66e179b6747ae54108f82f8ade8b3c25d76fd30afde6c395822c530196169"},
		{"long key", strings.Repeat("k", 131), "payload", "01968c76d7977271e1a5e8472726409596091f349aaca01ce8c1307c89e87f47"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := []byte(tc.payload)
			original := bytes.Clone(payload)
			want := "sha256=" + tc.digest
			require.Equal(t, want, signPayload(tc.secret, payload))
			require.True(t, VerifyPayloadSignature(tc.secret, payload, want))
			require.True(t, VerifyPayloadSignature(tc.secret, payload, " \tsha256= \t"+strings.ToUpper(tc.digest)+"\r\n"))
			require.False(t, VerifyPayloadSignature(tc.secret+"x", payload, want))
			require.False(t, VerifyPayloadSignature(tc.secret, append(bytes.Clone(payload), 0), want))
			for i := range payload {
				changed := bytes.Clone(payload)
				changed[i] ^= 1
				require.False(t, VerifyPayloadSignature(tc.secret, changed, want), "payload byte %d", i)
			}
			digest, err := hex.DecodeString(tc.digest)
			require.NoError(t, err)
			for i := range digest {
				changed := bytes.Clone(digest)
				changed[i] ^= 1
				require.False(t, VerifyPayloadSignature(tc.secret, payload, "sha256="+hex.EncodeToString(changed)), "digest byte %d", i)
			}
			require.Equal(t, original, payload)
		})
	}
}

func TestDeliveryContract_SignatureAdmission(t *testing.T) {
	t.Parallel()
	const digest = "2083f94244aa333f17324ede37c65d60c128331cc1bc5e5873b2bab633b2087c"
	payload := []byte(`{"event":"ping"}`)
	for _, signature := range []string{
		"", " \t\r\n", digest, "SHA256=" + digest, "sha1=" + digest,
		"sha256=sha256=" + digest, "sha256=" + digest[:63], "sha256=" + digest + "0",
		"sha256=" + strings.Repeat("g", 64), "sha256=" + digest[:32] + " " + digest[33:],
		"sha256=" + digest + ",sha256=" + digest, "sha256=" + digest + "\x00",
	} {
		t.Run(fmt.Sprintf("header_%q", signature), func(t *testing.T) {
			require.False(t, VerifyPayloadSignature("hook-secret", payload, signature))
		})
	}
	for _, secret := range []string{"", " ", "\t\r\n", "\u2003"} {
		t.Run(fmt.Sprintf("blank_secret_%q", secret), func(t *testing.T) {
			// Even the matching signature may not admit an unconfigured secret.
			require.False(t, VerifyPayloadSignature(secret, payload, signPayload(secret, payload)))
		})
	}
	// A configured secret is opaque: trimming it changes the authentication key.
	require.False(t, VerifyPayloadSignature(" hook-secret ", payload, "sha256="+digest))
}

func TestDeliveryContract_DisableWindowCombinations(t *testing.T) {
	t.Parallel()
	// The first ten rows are the newest deliveries. Exhaust all success/failure
	// combinations and deliberately put the opposite outcome outside the window.
	for mask := range 1 << 10 {
		statuses := make([]string, 12)
		for i := range 10 {
			statuses[i] = "failed"
			if mask&(1<<i) != 0 {
				statuses[i] = "success"
			}
		}
		statuses[10], statuses[11] = "success", "success"
		if mask != 0 {
			statuses[10], statuses[11] = "failed", "failed"
		}
		before := slices.Clone(statuses)
		require.Equal(t, mask == 0, shouldDisableWebhook(statuses), "success mask %010b", mask)
		require.Equal(t, before, statuses)
	}
	for length := range 10 {
		require.False(t, shouldDisableWebhook(slices.Repeat([]string{"failed"}, length)), "short window %d", length)
	}
	require.False(t, shouldDisableWebhook(nil))
	for _, status := range []string{"pending", "retrying", "", "FAILED", " failed"} {
		for position := range 10 {
			statuses := slices.Repeat([]string{"failed"}, 10)
			statuses[position] = status
			require.False(t, shouldDisableWebhook(statuses), "status %q at %d", status, position)
		}
	}
}

func TestDeliveryContract_RetryBoundaries(t *testing.T) {
	t.Parallel()
	zone := time.FixedZone("test +0545", 5*3600+45*60)
	for _, now := range []time.Time{time.Time{}, time.Date(2026, 12, 31, 23, 59, 59, 999999999, zone)} {
		for _, attempt := range []int32{math.MinInt32, -1, 0, 4, math.MaxInt32} {
			next, ok := CalculateNextRetry(attempt, now)
			require.False(t, ok)
			require.Equal(t, time.Time{}, next)
		}
		for _, tc := range []struct {
			attempt int32
			delay   time.Duration
		}{{1, time.Second}, {2, 10 * time.Second}, {3, time.Minute}} {
			next, ok := CalculateNextRetry(tc.attempt, now)
			require.True(t, ok)
			require.Equal(t, now.Add(tc.delay), next)
			require.Same(t, now.Location(), next.Location())
		}
	}
}
