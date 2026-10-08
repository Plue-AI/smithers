package services

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// QualificationAuthority is a main-reviewed signing key and reference-machine
// identity. Neither install settings nor an environment variable can add one.
type QualificationAuthority struct {
	HostID    string
	PublicKey ed25519.PublicKey
}

var approvedQualificationAuthorities = map[string]QualificationAuthority{}

// QualificationIdentity is the running bundle and machine, never request data.
type QualificationIdentity struct{ Commit, InstallVersion, BundleDigest, Origin, HostID string }
type QualificationReceipt struct {
	Name            string   `json:"name"`
	Status          string   `json:"status"`
	Commit          string   `json:"commit"`
	BundleDigest    string   `json:"bundle_digest"`
	InventoryDigest string   `json:"inventory_digest"`
	Provenance      string   `json:"provenance"`
	ReceiptDigest   string   `json:"receipt_digest"`
	Paths           []string `json:"paths"`
}
type MachineQualification struct {
	Version         int                    `json:"version"`
	Status          string                 `json:"status"`
	Commit          string                 `json:"commit"`
	InstallVersion  string                 `json:"install_version"`
	Origin          string                 `json:"origin"`
	Runtime         string                 `json:"runtime"`
	NonRoot         bool                   `json:"non_root"`
	BundleDigest    string                 `json:"bundle_digest"`
	InventoryDigest string                 `json:"inventory_digest"`
	ReviewedBy      string                 `json:"reviewed_by"`
	HostID          string                 `json:"host_id"`
	Receipts        []QualificationReceipt `json:"receipts"`
}

var qualificationPaths = map[string][]string{
	"TestGuestHelperInstallPinsInterpreterAndEnv": {"fresh", "retained"},
	"TestRootSetupNeverFollowsMemberSymlinks":     {"fresh", "retained"},
	"TestRootPreflightParsesOnlyEnvelope":         {"exec", "file", "terminal", "relay"},
	"TestRootLayerInputsValidatedBeforeUse":       {"layer"},
	"TestSSHRootInputsValidatedBeforeUse":         {"ssh", "retained"},
	"TestTerminalRootInputsValidatedBeforeUse":    {"terminal"},
	"TestBranchMachineRootInputsValidated":        {"fresh", "retained"},
	"TestMemberImageRootInputs":                   {"member-image"},
	"TestLiveDocumentBrokerInputs":                {"document", "retained"},
}
var qualificationDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var qualificationCommit = regexp.MustCompile(`^[a-f0-9]{40}$`)

// InstallQualification authenticates a signed, bounded data document. It never
// runs receipt commands or activates a runtime/document feature.
type InstallQualification struct {
	Read        func(context.Context) ([]byte, error)
	Identity    func(context.Context) (QualificationIdentity, error)
	Authorities map[string]QualificationAuthority
}

func strictQualificationJSON(data []byte, value any) bool {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	return d.Decode(value) == nil && d.Decode(new(any)) == io.EOF
}
func (s *InstallQualification) Snapshot(ctx context.Context) any {
	unavailable := map[string]any{"version": 1, "status": "unavailable", "missing": []string{"T-INS-02", "T-MCH-11", "T-SEC-01", "T-MCH-10"}}
	if s == nil || s.Read == nil || s.Identity == nil || len(s.Authorities) == 0 {
		return unavailable
	}
	data, err := s.Read(ctx)
	if err != nil || len(data) > 1<<20 {
		return unavailable
	}
	var envelope struct {
		KeyID     string          `json:"key_id"`
		Payload   json.RawMessage `json:"payload"`
		Signature string          `json:"signature"`
	}
	if !strictQualificationJSON(data, &envelope) {
		return unavailable
	}
	authority, ok := s.Authorities[envelope.KeyID]
	signature, err := base64.StdEncoding.DecodeString(envelope.Signature)
	if !ok || err != nil || len(authority.PublicKey) != ed25519.PublicKeySize || !ed25519.Verify(authority.PublicKey, envelope.Payload, signature) {
		return unavailable
	}
	var q MachineQualification
	if !strictQualificationJSON(envelope.Payload, &q) {
		return unavailable
	}
	id, err := s.Identity(ctx)
	origin, originErr := url.Parse(id.Origin)
	validOrigin := originErr == nil && origin.User == nil && (origin.Scheme == "http" || origin.Scheme == "https") && origin.Host != "" && origin.Path == "" && origin.RawQuery == "" && origin.Fragment == ""
	if validOrigin {
		host := strings.ToLower(origin.Hostname())
		validOrigin = host != "localhost" && host != "::1" && host != "::" && host != "0.0.0.0" && !strings.HasPrefix(host, "127.") && !strings.HasSuffix(host, ".localhost")
	}
	if err != nil || !validOrigin || q.Version != 1 || q.Status != "qualified" || !qualificationCommit.MatchString(id.Commit) || id.InstallVersion == "" || id.Origin == "" || id.HostID == "" ||
		q.Commit != id.Commit || q.InstallVersion != id.InstallVersion || q.BundleDigest != id.BundleDigest || q.Origin != id.Origin || q.HostID != id.HostID || q.HostID != authority.HostID ||
		q.Runtime != "microvm" || !q.NonRoot || q.ReviewedBy != "smithers-3f" || !qualificationDigest.MatchString(q.BundleDigest) || !qualificationDigest.MatchString(q.InventoryDigest) || len(q.Receipts) != len(qualificationPaths) {
		return unavailable
	}
	seen := map[string]bool{}
	for _, receipt := range q.Receipts {
		paths, ok := qualificationPaths[receipt.Name]
		if !ok || seen[receipt.Name] || receipt.Status != "passed" || receipt.Commit != q.Commit || receipt.BundleDigest != q.BundleDigest || receipt.InventoryDigest != q.InventoryDigest || receipt.Provenance != "authenticated-reference-host" || !qualificationDigest.MatchString(receipt.ReceiptDigest) {
			return unavailable
		}
		seen[receipt.Name] = true
		actual := map[string]bool{}
		for _, p := range receipt.Paths {
			if actual[p] {
				return unavailable
			}
			actual[p] = true
		}
		for _, p := range paths {
			if !actual[p] {
				return unavailable
			}
		}
	}
	return q
}

// NewInstalledQualification reads an operator-delivered signed data file. Its
// path supplies bytes only; the committed authority list supplies approval.
// The release's immutable revision is its qualification install version.
func NewInstalledQualification(origin string) *InstallQualification {
	return &InstallQualification{
		Authorities: approvedQualificationAuthorities,
		Read: func(ctx context.Context) ([]byte, error) {
			file := os.Getenv("SMITHERS_MACHINE_QUALIFICATION_FILE")
			if file == "" {
				root := os.Getenv("SMITHERS_DATA_ROOT")
				if root == "" {
					return nil, os.ErrNotExist
				}
				file = filepath.Join(root, "machine-qualification.json")
			}
			fd, err := unix.Open(file, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
			if err != nil {
				return nil, err
			}
			f := os.NewFile(uintptr(fd), "qualification")
			defer f.Close()
			stat, err := f.Stat()
			if err != nil || !stat.Mode().IsRegular() {
				return nil, os.ErrInvalid
			}
			return io.ReadAll(io.LimitReader(f, (1<<20)+1))
		},
		Identity: func(ctx context.Context) (QualificationIdentity, error) {
			if runtime.GOOS != "darwin" {
				return QualificationIdentity{}, os.ErrInvalid
			}
			executable, err := os.Executable()
			if err != nil {
				return QualificationIdentity{}, err
			}
			bundle, err := installbundle.OpenRunning(executable)
			if err != nil {
				return QualificationIdentity{}, err
			}
			probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			output, err := exec.CommandContext(probeCtx, "/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
			if err != nil {
				return QualificationIdentity{}, err
			}
			match := regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"`).FindSubmatch(output)
			if len(match) != 2 {
				return QualificationIdentity{}, os.ErrInvalid
			}
			effectiveOrigin := origin
			if resolved, ok := middleware.EffectiveOriginFromContext(ctx); ok {
				effectiveOrigin = resolved
			}
			return QualificationIdentity{Commit: bundle.Revision(), InstallVersion: bundle.Revision(), BundleDigest: bundle.ManifestSHA256(), Origin: strings.TrimRight(effectiveOrigin, "/"), HostID: strings.ToUpper(string(match[1]))}, nil
		},
	}
}
