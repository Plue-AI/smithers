package webhook

import (
	"encoding/base64"
	"fmt"
	"strings"

	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
)

// SecretCodec encodes webhook signing secrets for storage and use.
type SecretCodec interface {
	EncryptString(plaintext string) (string, error)
	DecryptString(ciphertext string) (string, error)
}

// AESGCMSecretCodec encrypts stored secrets with AES-256-GCM under the
// operator key. It seals only with the current key and opens with the current
// key or a previous one, so an operator key rotates without downtime: Reseal
// moves each stored value to the current key, then the previous key retires.
type AESGCMSecretCodec struct {
	key      []byte
	previous [][]byte
}

// NewSecretCodec builds a codec from the operator key and the keys it
// replaced, newest first.
func NewSecretCodec(secret string, previous ...string) (*AESGCMSecretCodec, error) {
	trimmed := strings.TrimSpace(secret)
	if trimmed == "" {
		return nil, fmt.Errorf("webhook secret encryption key is required")
	}
	codec := &AESGCMSecretCodec{key: smitherscrypto.DeriveKey(trimmed)}
	seen := map[string]bool{trimmed: true}
	for _, key := range previous {
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, fmt.Errorf("previous secret encryption key is empty")
		}
		if seen[key] {
			return nil, fmt.Errorf("previous secret encryption keys repeat a key")
		}
		seen[key] = true
		codec.previous = append(codec.previous, smitherscrypto.DeriveKey(key))
	}
	return codec, nil
}

func (c *AESGCMSecretCodec) EncryptString(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}

	ciphertext, err := smitherscrypto.Encrypt(c.key, []byte(plaintext))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (c *AESGCMSecretCodec) DecryptString(ciphertext string) (string, error) {
	plaintext, _, err := c.open(ciphertext)
	return plaintext, err
}

// Reseal returns ciphertext sealed under the current key. It reports false,
// with the input unchanged, when the value already opens under the current
// key, and fails when no configured key opens it.
func (c *AESGCMSecretCodec) Reseal(ciphertext string) (string, bool, error) {
	plaintext, current, err := c.open(ciphertext)
	if err != nil || current {
		return ciphertext, false, err
	}
	resealed, err := c.EncryptString(plaintext)
	if err != nil {
		return ciphertext, false, err
	}
	return resealed, true, nil
}

// open reports whether the current key opened the value. GCM authentication
// makes a wrong key fail rather than return garbage.
func (c *AESGCMSecretCodec) open(ciphertext string) (string, bool, error) {
	if ciphertext == "" {
		return "", true, nil
	}

	cipherBytes, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", false, err
	}

	plaintext, err := smitherscrypto.Decrypt(c.key, cipherBytes)
	if err == nil {
		return string(plaintext), true, nil
	}
	for _, key := range c.previous {
		if plaintext, previousErr := smitherscrypto.Decrypt(key, cipherBytes); previousErr == nil {
			return string(plaintext), false, nil
		}
	}
	return "", false, err
}

// NoopSecretCodec leaves strings unchanged (useful in tests).
type NoopSecretCodec struct{}

func (NoopSecretCodec) EncryptString(plaintext string) (string, error) {
	return plaintext, nil
}

func (NoopSecretCodec) DecryptString(ciphertext string) (string, error) {
	return ciphertext, nil
}
