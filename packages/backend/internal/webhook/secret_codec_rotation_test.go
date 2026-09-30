package webhook

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSecretCodecOpensPreviousKeysAndSealsWithCurrent(t *testing.T) {
	oldest, err := NewSecretCodec("oldest")
	require.NoError(t, err)
	old, err := NewSecretCodec("old")
	require.NoError(t, err)
	fromOldest, err := oldest.EncryptString("oldest value")
	require.NoError(t, err)
	fromOld, err := old.EncryptString("old value")
	require.NoError(t, err)

	rotated, err := NewSecretCodec("new", "old", "oldest")
	require.NoError(t, err)
	for ciphertext, want := range map[string]string{fromOldest: "oldest value", fromOld: "old value"} {
		got, err := rotated.DecryptString(ciphertext)
		require.NoError(t, err)
		require.Equal(t, want, got)
	}
	sealed, err := rotated.EncryptString("fresh")
	require.NoError(t, err)
	current, err := NewSecretCodec("new")
	require.NoError(t, err)
	got, err := current.DecryptString(sealed)
	require.NoError(t, err)
	require.Equal(t, "fresh", got, "a rotated codec seals only with the current key")
	_, err = old.DecryptString(sealed)
	require.Error(t, err)

	// Without the previous key the old value is unreadable, never garbage.
	_, err = current.DecryptString(fromOld)
	require.Error(t, err)
}

func TestSecretCodecReseal(t *testing.T) {
	old, err := NewSecretCodec("old")
	require.NoError(t, err)
	stranger, err := NewSecretCodec("stranger")
	require.NoError(t, err)
	rotated, err := NewSecretCodec("new", "old")
	require.NoError(t, err)
	current, err := NewSecretCodec("new")
	require.NoError(t, err)

	fromOld, err := old.EncryptString("value")
	require.NoError(t, err)
	resealed, changed, err := rotated.Reseal(fromOld)
	require.NoError(t, err)
	require.True(t, changed)
	require.NotEqual(t, fromOld, resealed)
	got, err := current.DecryptString(resealed)
	require.NoError(t, err)
	require.Equal(t, "value", got)

	again, changed, err := rotated.Reseal(resealed)
	require.NoError(t, err)
	require.False(t, changed, "a value under the current key stays as it is")
	require.Equal(t, resealed, again)

	empty, changed, err := rotated.Reseal("")
	require.NoError(t, err)
	require.False(t, changed)
	require.Empty(t, empty)

	foreign, err := stranger.EncryptString("value")
	require.NoError(t, err)
	unchanged, changed, err := rotated.Reseal(foreign)
	require.Error(t, err, "a value no configured key opens is refused")
	require.False(t, changed)
	require.Equal(t, foreign, unchanged)

	_, _, err = rotated.Reseal("not base64 !")
	require.Error(t, err)
}

func TestNewSecretCodecRefusesBadPreviousKeys(t *testing.T) {
	for name, previous := range map[string][]string{
		"blank":           {" "},
		"repeats":         {"old", " old "},
		"repeats current": {"new"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := NewSecretCodec("new", previous...)
			require.Error(t, err)
		})
	}
}
