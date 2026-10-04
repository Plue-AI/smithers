package githubfake

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
)

// LocalSeed uses fresh credentials and names distinct from rehearsal canaries.
func LocalSeed() (Config, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return Config{}, err
	}
	return Config{AppID: 1, Slug: "smithers-local", OwnerLogin: "local-owner", OwnerKind: "user",
		PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})),
		ClientID:      freshCode(), ClientSecret: freshCode(), WebhookSecret: freshCode(), ConversionCode: freshCode(),
		Installations: []Installation{{ID: 1, Repositories: []Repository{{ID: 1, FullName: "local-owner/demo", Private: true}}}}}, nil
}
