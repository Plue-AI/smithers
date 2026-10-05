package microsandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// This tests real msb stdin transport and guest ownership, without environment
// layer builders or workspace-name sweeps. Its synthetic ELF is an installation
// positive control, not a runnable native source-publication helper.
func TestRealMicroVMCodingBindingInstallation(t *testing.T) {
	if os.Getenv("SMITHERS_FLOW_BINDING_CHECK") != "1" {
		t.Skip("set SMITHERS_FLOW_BINDING_CHECK=1 for the real guest binding smoke")
	}
	binary := os.Getenv("SMITHERS_MICROSANDBOX_BIN")
	require.NotEmpty(t, binary, "SMITHERS_MICROSANDBOX_BIN must name the native pinned msb binary; npm shims need Node outside the runtime's scrubbed PATH")
	client, err := newCLI(binary)
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	evidence := os.Getenv("SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR")
	writeEvidence := func(name string, body []byte) {
		t.Helper()
		if evidence == "" {
			return
		}
		require.NoError(t, os.MkdirAll(evidence, 0700))
		require.NoError(t, os.WriteFile(filepath.Join(evidence, name), body, 0600))
	}
	work := t.TempDir()
	contents := make([]byte, 64)
	copy(contents, []byte("\x7fELF"))
	contents[4], contents[5], contents[18] = 2, 1, 183
	bundle := filepath.Join(work, "bundle")
	require.NoError(t, os.MkdirAll(filepath.Join(bundle, "bin", "linux-arm64"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(bundle, filepath.FromSlash(codingHelperBundlePath)), contents, 0o755))
	helperSum := sha256.Sum256(contents)
	writeBundleManifest(t, bundle, []map[string]any{{"path": codingHelperBundlePath, "sha256": hex.EncodeToString(helperSum[:]), "stage": "fixture", "mode": 0o755}})
	guestFile := filepath.Join(work, "smithers-guest.py")
	require.NoError(t, os.WriteFile(guestFile, guestHelper, 0644))
	vm := "lane-flw-binding-" + uuid.NewString()
	workspaceID := "binding-" + uuid.NewString()
	writeEvidence("binding-msb-name.txt", []byte(vm+"\n"))
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		output, err := client.run(cleanupCtx, nil, "remove", "--force", vm)
		writeEvidence("binding-msb-cleanup.txt", append(output, []byte(fmt.Sprintf("\nerror=%v\n", err))...))
		require.NoError(t, err, "cleanup only owned VM %s: %s", vm, output)
	})
	run := func(args ...string) []byte {
		t.Helper()
		output, err := client.run(ctx, nil, args...)
		require.NoError(t, err, "msb %v: %s", args, output)
		return output
	}
	writeEvidence("binding-msb-create.txt", run("create", DefaultImage, "--pull", "never", "--name", vm, "--memory", "1G", "--cpus", "1", "--root-disk", "2G", "--no-net", "--copy-file", guestFile+":"+guestHelperPath))
	runtime := &Runtime{cli: client, config: Config{Bundle: bundle}, workspaces: map[string]*workspace{
		workspaceID: newWorkspace(metadata{Version: metadataVersion, ID: workspaceID, Machine: vm, State: "running"}, work),
	}}
	_, err = runtime.guest(ctx, vm, nil, "setup", guestUser, fmt.Sprint(guestUID), guestRoot, guestStateDir, guestTempDir)
	require.NoError(t, err)
	fixture := codingBindingFixture()
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(ctx, workspaceID, fixture), "actual msb stdin transports helper bytes and binding JSON")
	output := run("exec", vm, "--", "python3", "-c", `import hashlib,json,os,stat
config_path="/etc/smithers/workspace-coding.json"
helper_path="/usr/local/bin/smithers-jj-export"
with open(config_path) as f: binding=json.load(f)
with open(helper_path,"rb") as f: digest=hashlib.sha256(f.read()).hexdigest()
config=os.stat(config_path); helper=os.stat(helper_path)
print(json.dumps({"binding":binding,"configOwner":config.st_uid,"configMode":stat.S_IMODE(config.st_mode),"helperOwner":helper.st_uid,"helperMode":stat.S_IMODE(helper.st_mode),"helperSHA256":digest}))`)
	writeEvidence("binding-guest-installation-receipt.json", output)
	var receipt struct {
		Binding      map[string]any `json:"binding"`
		ConfigOwner  int            `json:"configOwner"`
		ConfigMode   int            `json:"configMode"`
		HelperOwner  int            `json:"helperOwner"`
		HelperMode   int            `json:"helperMode"`
		HelperSHA256 string         `json:"helperSHA256"`
	}
	require.NoError(t, json.Unmarshal(output, &receipt))
	require.Zero(t, receipt.ConfigOwner)
	require.Equal(t, 0644, receipt.ConfigMode)
	require.Zero(t, receipt.HelperOwner)
	require.Equal(t, 0755, receipt.HelperMode)
	sum := sha256.Sum256(contents)
	require.Equal(t, hex.EncodeToString(sum[:]), receipt.HelperSHA256)
	require.Equal(t, workspaceID, receipt.Binding["workspaceId"])
	require.Equal(t, guestRoot, receipt.Binding["repositoryPath"])
	require.Equal(t, guestUser, receipt.Binding["username"])
	require.Equal(t, guestHome+"/.cache/smithers/git-credential/socket", receipt.Binding["credentialSocket"])
	require.Equal(t, float64(fixture.ActorID), receipt.Binding["actorId"])
	require.Equal(t, float64(fixture.RepositoryID), receipt.Binding["repositoryId"])
	require.Equal(t, fixture.RepositorySlug, receipt.Binding["repositorySlug"])
	require.Equal(t, fixture.APIBaseURL, receipt.Binding["apiBaseUrl"])
	require.Equal(t, fixture.GitURL, receipt.Binding["gitUrl"])
	output = run("exec", vm, "--", "runuser", "-u", guestUser, "--", "python3", "-c", `import json,os
refused=[]
for path in ("/etc/smithers/workspace-coding.json","/usr/local/bin/smithers-jj-export"):
    try:
        with open(path,"wb") as f: f.write(b"tampered")
    except PermissionError:
        refused.append(path)
assert len(refused)==2
print(json.dumps({"uid":os.geteuid(),"refused":refused}))`)
	writeEvidence("binding-guest-write-refusals.json", output)
	var denied struct {
		UID     int      `json:"uid"`
		Refused []string `json:"refused"`
	}
	require.NoError(t, json.Unmarshal(output, &denied))
	require.Equal(t, guestUID, denied.UID)
	require.Len(t, denied.Refused, 2)
	t.Logf("installed fixed root-owned binding and synthetic ELF installation fixture in %s; guest UID %d cannot rewrite either", vm, denied.UID)
}
