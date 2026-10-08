package microsandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

type SecretScanHit struct {
	Path   string `json:"path"`
	Label  string `json:"label"`
	SHA256 string `json:"sha256"`
}
type SecretScanFailure struct {
	Path  string `json:"path"`
	Errno int    `json:"errno"`
}
type SecretScan struct {
	Hits     []SecretScanHit     `json:"hits"`
	Failures []SecretScanFailure `json:"failures"`
	Files    int64               `json:"files"`
	Bytes    int64               `json:"bytes"`
}

// ScanInstalledMachine inspects an already-running reference-host fixture
// without reopening runtime state or stopping any VM. The helper must already
// be installed by the bundle; this diagnostic never plants a lane artifact.
func ScanInstalledMachine(ctx context.Context, config Config, machine string, sentinels map[string]string) (SecretScan, error) {
	if config.Bundle == nil || machine == "" {
		return SecretScan{}, fmt.Errorf("secret scan requires installed machine")
	}
	binary, verify, err := startupChecks(config)
	if err != nil {
		return SecretScan{}, err
	}
	client, err := runtimeCLI(binary, verify)
	if err != nil {
		return SecretScan{}, err
	}
	body, err := json.Marshal(sentinels)
	if err != nil || len(body) > 8192 {
		return SecretScan{}, fmt.Errorf("invalid scan sentinels")
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	output, err := client.run(callCtx, body, guestArgs(machine, nil, false, "scan-secrets")...)
	if err != nil {
		return SecretScan{}, err
	}
	var scan SecretScan
	if err = json.Unmarshal(output, &scan); err != nil {
		return SecretScan{}, err
	}
	if len(scan.Failures) > 0 || scan.Files == 0 {
		return scan, fmt.Errorf("secret scan incomplete")
	}
	return scan, nil
}
