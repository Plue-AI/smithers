package webhook_test

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// Independent format fixture: SHA-256("codec-contract-key"), AES-256-GCM,
// nonce 000102030405060708090a0b, no additional authenticated data. Neither
// the key nor this ciphertext is produced by the codec under test.
const codecContractKey = "2a3e88b078e66fc4f90877b638b0e7964dab970ab75bec49fcaaec33667dac8d"
const codecContractWire = "AAECAwQFBgcICQoL9lkbTL+bfCyLvYkETnZuAUe1D2k14271YiYHihftC6iLXYs44/EYrmTYwuDuag=="
const codecContractPlain = "webhook signing secret: 😀\x00\xff"

func TestSecretCodecReadsIndependentStoredFormat(t *testing.T) {
	t.Parallel()
	for _, secret := range []string{"codec-contract-key", " \tcodec-contract-key\r\n"} {
		codec, err := webhook.NewSecretCodec(secret)
		require.NoError(t, err)
		plain, err := codec.DecryptString(codecContractWire)
		require.NoError(t, err)
		require.Equal(t, codecContractPlain, plain)
	}
}

func TestSecretCodecAuthenticatesEveryStoredByte(t *testing.T) {
	t.Parallel()
	codec, err := webhook.NewSecretCodec("codec-contract-key")
	require.NoError(t, err)
	wire, err := base64.StdEncoding.DecodeString(codecContractWire)
	require.NoError(t, err)
	// Includes every nonce, ciphertext and authentication-tag byte.
	for index := range wire {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			changed := append([]byte(nil), wire...)
			changed[index] ^= 1
			plain, err := codec.DecryptString(base64.StdEncoding.EncodeToString(changed))
			require.Error(t, err)
			require.Empty(t, plain, "unauthenticated data must never escape")
		})
	}
	// A codec remains usable after a rejected record.
	plain, err := codec.DecryptString(codecContractWire)
	require.NoError(t, err)
	require.Equal(t, codecContractPlain, plain)
}

func TestSecretCodecRejectsTruncatedExtendedAndWrongKeyRecords(t *testing.T) {
	t.Parallel()
	codec, err := webhook.NewSecretCodec("codec-contract-key")
	require.NoError(t, err)
	wire, err := base64.StdEncoding.DecodeString(codecContractWire)
	require.NoError(t, err)
	// Empty storage is an intentional sentinel, tested separately below.
	for length := 1; length < len(wire); length++ {
		plain, err := codec.DecryptString(base64.StdEncoding.EncodeToString(wire[:length]))
		require.Error(t, err, "prefix length %d", length)
		require.Empty(t, plain)
	}
	plain, err := codec.DecryptString(base64.StdEncoding.EncodeToString(append(wire, 0)))
	require.Error(t, err)
	require.Empty(t, plain)
	other, err := webhook.NewSecretCodec("another-codec-contract-key")
	require.NoError(t, err)
	plain, err = other.DecryptString(codecContractWire)
	require.Error(t, err)
	require.Empty(t, plain)
}

func TestSecretCodecProducesInteroperableOpaqueByteRecords(t *testing.T) {
	t.Parallel()
	key, err := hex.DecodeString(codecContractKey)
	require.NoError(t, err)
	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	gcm, err := cipher.NewGCM(block)
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("codec-contract-key")
	require.NoError(t, err)
	for _, plain := range []string{" ", codecContractPlain, "\x00\xff\xfe", strings.Repeat("key-byte", 1024)} {
		encoded, err := codec.EncryptString(plain)
		require.NoError(t, err)
		wire, err := base64.StdEncoding.DecodeString(encoded)
		require.NoError(t, err)
		require.Len(t, wire, 12+len(plain)+16)
		decoded, err := gcm.Open(nil, wire[:12], wire[12:], nil)
		require.NoError(t, err)
		require.Equal(t, []byte(plain), decoded)
		stored, err := codec.DecryptString(encoded)
		require.NoError(t, err)
		require.Equal(t, plain, stored, "reading storage must preserve every secret byte")
	}
}

func TestSecretCodecEmptySentinelAndMalformedRecords(t *testing.T) {
	t.Parallel()
	codec, err := webhook.NewSecretCodec("codec-contract-key")
	require.NoError(t, err)
	for _, operation := range []func(string) (string, error){codec.EncryptString, codec.DecryptString} {
		value, err := operation("")
		require.NoError(t, err)
		require.Empty(t, value)
	}
	// Valid base64 can still be an invalid encrypted record.
	for _, malformed := range []string{"=", "AAAA=", "AA==", "bm90LWVuY3J5cHRlZA==", codecContractWire[:len(codecContractWire)-1]} {
		plain, err := codec.DecryptString(malformed)
		require.Error(t, err)
		require.Empty(t, plain)
	}
}

func TestSecretCodecNoopPreservesOpaqueBytes(t *testing.T) {
	t.Parallel()
	codec := webhook.NoopSecretCodec{}
	for _, plain := range []string{"", " \tkey\n", codecContractPlain, codecContractWire} {
		for _, operation := range []func(string) (string, error){codec.EncryptString, codec.DecryptString} {
			value, err := operation(plain)
			require.NoError(t, err)
			require.Equal(t, plain, value)
		}
	}
}
