package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// setupTokenStore is install_settings as MintSetupToken sees it.
type setupTokenStore struct {
	hasOwner bool
	settings map[string]json.RawMessage
}

func (s *setupTokenStore) InstallHasOwner(context.Context) (bool, error) { return s.hasOwner, nil }

func (s *setupTokenStore) PutInstallSetting(_ context.Context, arg db.PutInstallSettingParams) error {
	s.settings[arg.Key] = arg.Value
	return nil
}

func (s *setupTokenStore) DeleteInstallSetting(_ context.Context, key string) (int64, error) {
	_, ok := s.settings[key]
	delete(s.settings, key)
	if ok {
		return 1, nil
	}
	return 0, nil
}

func TestMintSetupTokenStoresOnlyTheDigest(t *testing.T) {
	store := &setupTokenStore{settings: map[string]json.RawMessage{}}
	token, err := MintSetupToken(context.Background(), store)
	require.NoError(t, err)
	require.Len(t, token, 43, "32 random bytes, base64url without padding")

	stored := string(store.settings[setupTokenKey])
	sum := sha256.Sum256([]byte(token))
	require.JSONEq(t, `{"digest":"`+hex.EncodeToString(sum[:])+`"}`, stored)
	require.NotContains(t, stored, token)
	require.True(t, setupTokenMatches(store.settings[setupTokenKey], SetupTokenDigest(token)))
	require.False(t, setupTokenMatches(store.settings[setupTokenKey], SetupTokenDigest(token+"x")))
	require.False(t, setupTokenMatches(store.settings[setupTokenKey], ""), "an empty digest never matches")
	require.False(t, setupTokenMatches(json.RawMessage(`{}`), ""), "an empty stored digest never matches")
}

func TestMintSetupTokenReplacesTheTokenOnEachStart(t *testing.T) {
	store := &setupTokenStore{settings: map[string]json.RawMessage{}}
	first, err := MintSetupToken(context.Background(), store)
	require.NoError(t, err)
	second, err := MintSetupToken(context.Background(), store)
	require.NoError(t, err)
	require.NotEqual(t, first, second)
	require.False(t, setupTokenMatches(store.settings[setupTokenKey], SetupTokenDigest(first)), "a restart retires the printed token")
	require.True(t, setupTokenMatches(store.settings[setupTokenKey], SetupTokenDigest(second)))
}

func TestMintSetupTokenIssuesNothingOnceAnOwnerExists(t *testing.T) {
	store := &setupTokenStore{hasOwner: true, settings: map[string]json.RawMessage{
		setupTokenKey: json.RawMessage(`{"digest":"left-over"}`),
	}}
	token, err := MintSetupToken(context.Background(), store)
	require.NoError(t, err)
	require.Empty(t, token)
	require.NotContains(t, store.settings, setupTokenKey, "no token exists once an owner does")
}

func TestSetupTokenDigestIgnoresSurroundingSpace(t *testing.T) {
	require.Equal(t, SetupTokenDigest("abc"), SetupTokenDigest(" abc\n"))
	require.Len(t, SetupTokenDigest("abc"), 64)
	require.Equal(t, strings.ToLower(SetupTokenDigest("abc")), SetupTokenDigest("abc"))
}
