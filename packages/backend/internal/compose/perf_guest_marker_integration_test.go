package compose

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/stretchr/testify/require"
)

// Supplemental Linux evidence: browser live ingress, installed daemon, native
// rewrite and retained document bytes are real. EmptyBroker does not qualify
// member cgroup freezing, privileged lifecycle or reference-host performance.
func TestPerfGuestHeldMarkerComposedInstall(t *testing.T) {
	f := startRealDocumentInstall(t, "")
	ben := f.browser(t, "ben-cookie")
	ben.sub(t, f.topic)
	client := ben.assigned(t)
	tx, err := f.pool.Begin(t.Context())
	require.NoError(t, err)
	actor, err := machined.RecordActorInTx(t.Context(), tx, f.branch, f.branch, machined.ActorIdentity{Kind: "person", MemberID: f.ben, Via: "web"})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(t.Context()))
	captured, err := f.registry.Capture(t.Context(), f.branch)
	require.NoError(t, err)
	gitDir := filepath.Join(f.root, ".git")
	tree, err := exec.CommandContext(t.Context(), "git", "--git-dir", gitDir, "rev-parse", captured.Head+"^{tree}").Output()
	require.NoError(t, err)
	command := exec.CommandContext(t.Context(), "git", "--git-dir", gitDir, "-c", "user.name=Perf fixture", "-c", "user.email=perf@example.invalid", "commit-tree", strings.TrimSpace(string(tree)))
	command.Stdin = strings.NewReader("Independent held-marker target\n")
	onto, err := command.Output()
	require.NoError(t, err)
	state := f.restart.State
	require.NoError(t, os.WriteFile(filepath.Join(state, "qualification-rebase-held.arm"), nil, 0600))
	done := make(chan error, 1)
	go func() {
		_, err := f.registry.Rebase(t.Context(), f.branch, actor, strings.TrimSpace(string(onto)))
		done <- err
	}()
	hit := filepath.Join(state, "qualification-rebase-held.hit")
	require.Eventually(t, func() bool { _, err := os.Stat(hit); return err == nil }, 10*time.Second, 10*time.Millisecond)
	t.Cleanup(func() { _ = os.Remove(hit) })
	const marker = "NORMAL_REBASE000"
	ben.edit(t, codeInsert(client, marker))
	rows := func() []map[string]any {
		raw, _ := os.ReadFile(filepath.Join(state, "rebase.jsonl"))
		lines := strings.Split(string(raw), "\n")
		lines = lines[:len(lines)-1]
		result := []map[string]any{}
		for _, line := range lines {
			if line == "" {
				continue
			}
			var row map[string]any
			require.NoError(t, json.Unmarshal([]byte(line), &row))
			result = append(result, row)
		}
		return result
	}
	require.Eventually(t, func() bool {
		for _, row := range rows() {
			if row["phase"] == "document_received" {
				return true
			}
		}
		return false
	}, 5*time.Second, 10*time.Millisecond, "authenticated daemon ingress must precede thaw")
	require.NoError(t, os.Remove(hit))
	require.NoError(t, <-done)
	ben.saved(t, 1)
	require.Equal(t, marker, f.disk(t))
	var held, thawed, observed map[string]any
	require.Eventually(t, func() bool {
		for _, row := range rows() {
			switch row["phase"] {
			case "held":
				held = row
			case "thawed":
				thawed = row
			case "marker":
				observed = row
			}
		}
		return observed != nil
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, held["id"], observed["id"])
	require.Equal(t, thawed["id"], observed["id"])
	evidence := observed["marker"].(map[string]any)
	require.Equal(t, marker, evidence["text"])
	require.Equal(t, true, evidence["typedDuringHold"])
	require.Equal(t, hex.EncodeToString(actor), evidence["actor_reference"])
	require.GreaterOrEqual(t, evidence["received"].(float64), held["start"].(float64))
	require.LessOrEqual(t, evidence["lastReceived"].(float64), thawed["end"].(float64))
	require.GreaterOrEqual(t, evidence["applied"].(float64), thawed["end"].(float64))
	// Resolve member identity through the same composed owner HTTP diagnostic
	// consumed by C-PERF-06. Guest opaque references cannot assert member IDs.
	req, err := http.NewRequest("GET", f.origin+"/api/install/ack-delay?branch="+f.branch+"&actor_reference="+hex.EncodeToString(actor), nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "ben-cookie"})
	response, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer response.Body.Close()
	var receipt struct {
		Branch, Boot string
		Actor        machined.ActorIdentity
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
	require.Equal(t, 200, response.StatusCode)
	require.Equal(t, f.branch, receipt.Branch)
	require.Equal(t, held["boot"], receipt.Boot)
	require.Equal(t, machined.ActorIdentity{Kind: "person", MemberID: f.ben, Via: "web"}, receipt.Actor)
	for _, tc := range []struct {
		cookie, reference string
		status            int
	}{
		{"", hex.EncodeToString(actor), 401},
		{"alice-cookie", hex.EncodeToString(actor), 403},
		{"ben-cookie", "Alice", 400},
		{"ben-cookie", strings.Repeat("0", 32), 404},
	} {
		req, err := http.NewRequest("GET", f.origin+"/api/install/ack-delay?branch="+f.branch+"&actor_reference="+tc.reference, nil)
		require.NoError(t, err)
		if tc.cookie != "" {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: tc.cookie})
		}
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		require.Equal(t, tc.status, response.StatusCode)
		require.NoError(t, response.Body.Close())
	}
	// The live adapter folds the actual guest log, then the independent verdict
	// verifies its interval and the actual authenticated attribution response.
	adapter, err := filepath.Abs("../../../../scripts/perf/rebase-production.mjs")
	require.NoError(t, err)
	verifier, err := filepath.Abs("../../../../scripts/perf/lib/rebase-receipts.mjs")
	require.NoError(t, err)
	source := `import {observations} from ` + strconv.Quote("file://"+adapter) + `;
    import {verifyHeldMarker} from ` + strconv.Quote("file://"+verifier) + `;
    const rows=await observations(process.argv[1],process.argv[2],process.argv[3],process.argv[4]);
    const hold=rows.find(row=>row.phase==="thawed");
    const attribution=JSON.parse(process.argv[5]);
    const marker={...hold.marker,member:String(attribution.Actor.member_id),attributionReceipt:{branch:attribution.Branch,boot:attribution.Boot,actor:attribution.Actor}};
    verifyHeldMarker(hold,marker,marker.member);
    for(const change of [{branch:"foreign"},{boot:"0".repeat(32)},{actor:{...attribution.Actor,member_id:999999}},{actor:{...attribution.Actor,kind:"agent"}}]){
      let refused=false;try{verifyHeldMarker(hold,{...marker,attributionReceipt:{...marker.attributionReceipt,...change}},marker.member)}catch{refused=true}
      if(!refused)throw new Error("foreign marker attribution accepted");
    }`
	encoded, err := json.Marshal(receipt)
	require.NoError(t, err)
	output, err := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", source, filepath.Join(state, "rebase.jsonl"), f.branch, strings.TrimSpace(string(onto)), receipt.Boot, string(encoded)).CombinedOutput()
	require.NoError(t, err, "%s", output)
}
