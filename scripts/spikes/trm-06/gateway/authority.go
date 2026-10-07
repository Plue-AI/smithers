package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"time"

	"github.com/smithersai/smithers/packages/backend/installbundle"
)

const gatewayArtifact = "bin/trm06-gateway"
const supervisorArtifact = "libexec/trm06-supervisor"
const installerArtifact = "share/trm06/install.py"
const reviewKeyArtifact = "share/trm06/smithers-3f.pub"
const approvalArtifact = "share/trm06/approval.json"

// The install owner pins the reviewer's public key in the installed bundle.
// A member, environment flag, receipt filename or branch cannot select it.
// Signing infrastructure and security review are outside this disposable probe.
type reviewApproval struct {
	Reviewer  string            `json:"reviewer"`
	Revision  string            `json:"revision"`
	Expires   string            `json:"expires"`
	Artifacts map[string]string `json:"artifacts"`
	Checks    []string          `json:"checks"`
}
type signedApproval struct {
	Payload   json.RawMessage `json:"payload"`
	Signature string          `json:"signature"`
}
type installedAuthority struct {
	bundle                *installbundle.Bundle
	supervisor, installer []byte
	supervisorSHA         string
}

func decodeStrict(data []byte, result any) error {
	// DisallowUnknownFields does not reject duplicate keys, including nested
	// artifact digests. Reject duplicates before interpreting any authority.
	d := json.NewDecoder(bytes.NewReader(data))
	if err := uniqueJSON(d); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errAuthority
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(result); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return errAuthority
	}
	return nil
}
func uniqueJSON(d *json.Decoder) error {
	token, err := d.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		if token == nil {
			return errAuthority
		}
		return nil
	}
	if delimiter != '{' && delimiter != '[' {
		return errAuthority
	}
	seen := map[string]bool{}
	for d.More() {
		if delimiter == '{' {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return errAuthority
			}
			seen[name] = true
		}
		if err := uniqueJSON(d); err != nil {
			return err
		}
	}
	end, err := d.Token()
	if err != nil {
		return err
	}
	if (delimiter == '{' && end != json.Delim('}')) || (delimiter == '[' && end != json.Delim(']')) {
		return errAuthority
	}
	return nil
}
func verifyApproval(data, key []byte, revision string, artifacts map[string]string, now time.Time) error {
	if len(data) > 65536 || len(key) != ed25519.PublicKeySize {
		return errAuthority
	}
	var envelope signedApproval
	if decodeStrict(data, &envelope) != nil {
		return errAuthority
	}
	signature, err := base64.StdEncoding.Strict().DecodeString(envelope.Signature)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(key), append([]byte("smithers-trm06/review/v1\n"), envelope.Payload...), signature) {
		return errAuthority
	}
	var approval reviewApproval
	if decodeStrict(envelope.Payload, &approval) != nil || approval.Reviewer != "smithers-3f" || approval.Revision != revision {
		return errAuthority
	}
	expiry, err := time.Parse(time.RFC3339, approval.Expires)
	if err != nil || !now.Before(expiry) {
		return errAuthority
	}
	if len(approval.Artifacts) != len(artifacts) {
		return errAuthority
	}
	for path, digest := range artifacts {
		if approval.Artifacts[path] != digest {
			return errAuthority
		}
	}
	required := map[string]bool{"C-SEC-02/R1": false, "C-SEC-02/R2": false, "C-SEC-02/R3": false, "C-SPK-08/root-prototype-install-validation": false, "C-SPK-08/root-session-input-validation": false}
	for _, check := range approval.Checks {
		if _, ok := required[check]; !ok || required[check] {
			return errAuthority
		}
		required[check] = true
	}
	for _, passed := range required {
		if !passed {
			return errAuthority
		}
	}
	return nil
}
func loadInstalledAuthority(executable string) (*installedAuthority, error) {
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, errAuthority
	}
	if filepath.Base(resolved) != "trm06-gateway" || filepath.Base(filepath.Dir(resolved)) != "bin" {
		return nil, errAuthority
	}
	bundle, err := installbundle.Open(filepath.Dir(filepath.Dir(resolved)))
	if err != nil {
		return nil, err
	}
	if member, ok := bundle.Member(resolved); !ok || member != gatewayArtifact {
		return nil, errAuthority
	}
	if err = bundle.Program(gatewayArtifact).Check(); err != nil {
		return nil, err
	}
	// Bind every bundle artifact to the signed review, including msb, kernel,
	// interpreter helpers and review key; the envelope itself cannot self-hash.
	artifacts := map[string]string{}
	// The manifest has bounded paths; Matching("*") excludes directories.
	patterns := []string{"*", "*/*", "*/*/*", "*/*/*/*", "*/*/*/*/*", "*/*/*/*/*/*", "*/*/*/*/*/*/*", "*/*/*/*/*/*/*/*"}
	for _, pattern := range patterns {
		for _, path := range bundle.Matching(pattern) {
			if path == approvalArtifact {
				continue
			}
			entry, _ := bundle.Entry(path)
			artifacts[path] = entry.SHA256
		}
	}
	key, _, err := bundle.Read(reviewKeyArtifact, 32)
	if err != nil {
		return nil, err
	}
	approval, _, err := bundle.Read(approvalArtifact, 65536)
	if err != nil {
		return nil, err
	}
	if err = verifyApproval(approval, key, bundle.Revision(), artifacts, time.Now()); err != nil {
		return nil, err
	}
	supervisor, entry, err := bundle.Read(supervisorArtifact, 64<<20)
	if err != nil {
		return nil, err
	}
	if entry.Mode != 0755 || entry.Stage != "trm06" {
		return nil, errAuthority
	}
	installer, entry, err := bundle.Read(installerArtifact, 65536)
	if err != nil {
		return nil, err
	}
	if entry.Mode != 0644 || entry.Stage != "trm06" {
		return nil, errAuthority
	}
	supervisorEntry, _ := bundle.Entry(supervisorArtifact)
	return &installedAuthority{bundle, supervisor, installer, supervisorEntry.SHA256}, nil
}
func (a *installedAuthority) recheck() error {
	// Approval expiration and protected paths are rechecked before privileged use.
	next, err := loadInstalledAuthority(a.bundle.Path(gatewayArtifact))
	if err != nil {
		return err
	}
	if next.bundle.ManifestSHA256() != a.bundle.ManifestSHA256() {
		return errAuthority
	}
	return nil
}
func authorityError(err error) error { return fmt.Errorf("%w: %v", errAuthority, err) }
