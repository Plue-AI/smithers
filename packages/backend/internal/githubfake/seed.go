package githubfake

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"regexp"
)

// gitHubLogin is GitHub's login rule: alphanumerics and single inner
// hyphens, at most 39 characters.
var gitHubLogin = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9]|-[A-Za-z0-9]){0,38}$`)

// LocalSeed uses fresh credentials and names distinct from rehearsal canaries.
func LocalSeed() (Config, error) { return LocalSeedFor("local-owner") }

// LocalSeedFor is LocalSeed with owner as the owner account and owner/demo
// as the one installed repository, so a browser walk can name its people
// (the proof recordings' owner is maya).
func LocalSeedFor(owner string) (Config, error) {
	if len(owner) > 39 || !gitHubLogin.MatchString(owner) {
		return Config{}, fmt.Errorf("owner %q is not a GitHub login", owner)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return Config{}, err
	}
	return Config{AppID: 1, Slug: "smithers-local", OwnerLogin: owner, OwnerKind: "user",
		PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})),
		ClientID:      freshCode(), ClientSecret: freshCode(), WebhookSecret: freshCode(), ConversionCode: freshCode(),
		Installations: []Installation{{ID: 1, Repositories: []Repository{{ID: 1, FullName: owner + "/demo", Private: true}}}}}, nil
}
