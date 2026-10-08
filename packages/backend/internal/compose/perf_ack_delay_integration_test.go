package compose

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
)

// PostgreSQL, session/CSRF authorization, install router, handshake, transaction
// receipts and event pump are real. The wire peer substitutes for the absent
// Linux microVM; this is not lifecycle qualification or C-PERF-06 evidence.
func TestPerfAckDelayComposedInstall(t *testing.T) {
	f := presenceInstall(t)
	registry := new(machined.Registry)
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	link, peer := presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, link.Connection.Reconciled())
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	httpServer := httptest.NewUnstartedServer(nil)
	f.origin = "http://" + httpServer.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{f.origin}
	cfg.Server.PublicURL = f.origin
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{AckDelay: &routes.InstallAckDelayHandler{Queries: db.New(f.pool), Registry: registry}})
	httpServer.Config.Handler = router
	httpServer.Start()
	t.Cleanup(httpServer.Close)
	call := func(method, body, cookie string) (int, machined.AckDelayReceipt) {
		req := httptest.NewRequest(method, f.origin+"/api/install/ack-delay?branch="+f.row.ID, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:51000"
		req.Header.Set("Origin", f.origin)
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "perf-csrf"})
			req.Header.Set("X-CSRF-Token", "perf-csrf")
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var receipt machined.AckDelayReceipt
		if w.Code == 200 {
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &receipt))
			require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
		}
		return w.Code, receipt
	}
	code, _ := call("POST", `{"branch":"`+f.row.ID+`","delay_ms":10000}`, "")
	require.Equal(t, 401, code)
	code, _ = call("POST", `{"branch":"`+f.row.ID+`","delay_ms":9999}`, f.cookie)
	require.Equal(t, 400, code)
	code, _ = call("POST", `{"branch":"`+f.row.ID+`","delay_ms":10000,"path":"/root"}`, f.cookie)
	require.Equal(t, 400, code)
	member, err := db.New(f.pool).CreateUser(t.Context(), db.CreateUserParams{Username: "perf-member", LowerUsername: "perf-member"})
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `INSERT INTO auth_sessions(user_id,username,session_key,expires_at) VALUES($1,$2,'perf-member-cookie',NOW()+interval '1 hour')`, member.ID, member.Username)
	require.NoError(t, err)
	code, _ = call("GET", "", "perf-member-cookie")
	require.Equal(t, 403, code)
	code, _ = call("POST", `{"branch":"`+f.row.ID+`","delay_ms":10000}`, "perf-member-cookie")
	require.Equal(t, 403, code)
	writer := &machined.Ingestor{Pool: f.pool, Write: func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.Acknowledgement, error) {
		_, err := tx.Exec(ctx, `UPDATE workspaces SET head_commit_id='perf-captured' WHERE id=$1`, branch)
		return machined.Acknowledgement{Outcome: machined.AckApplied}, err
	}}
	stop, err := registry.ConsumeEvents(t.Context(), func(ctx context.Context, l *machined.Link, b string, e machined.Event) (machined.Acknowledgement, error) {
		return writer.Commit(ctx, l.Connection, b, e)
	})
	require.NoError(t, err)
	t.Cleanup(stop)
	code, armed := call("POST", `{"branch":"`+f.row.ID+`","delay_ms":10000}`, f.cookie)
	require.Equal(t, 200, code)
	require.Equal(t, "armed", armed.State)
	require.NotEmpty(t, armed.Boot)
	code, _ = call("POST", `{"branch":"`+f.row.ID+`","delay_ms":10000}`, f.cookie)
	require.Equal(t, 409, code)
	eventID := [16]byte{91}
	payload := wire.Union(2, wire.Field(1, bytes.Repeat([]byte{1}, 20)), wire.Field(2, bytes.Repeat([]byte{2}, 20)), wire.Field(3, bytes.Repeat([]byte{3}, 20)))
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(1)), wire.Field(2, eventID[:]), wire.Field(3, payload))}))
	require.Eventually(t, func() bool { code, r := call("GET", "", f.cookie); return code == 200 && r.State == "withheld" }, 5*time.Second, 10*time.Millisecond)
	var head string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT head_commit_id FROM workspaces WHERE id=$1`, f.row.ID).Scan(&head))
	require.Equal(t, "perf-captured", head, "delay follows transaction commit")
	acked := make(chan error, 1)
	go func() {
		frame, err := wire.Read(peer)
		if err == nil && (frame.Kind != wire.Events || frame.Payload[0] != 3) {
			err = io.ErrUnexpectedEOF
		}
		acked <- err
	}()
	select {
	case err := <-acked:
		t.Fatalf("ACK arrived before restoration: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	code, released := call("POST", `{"branch":"`+f.row.ID+`","delay_ms":0}`, f.cookie)
	require.Equal(t, 200, code)
	require.Equal(t, armed.ID, released.ID)
	require.NoError(t, <-acked)
	require.Eventually(t, func() bool {
		_, r := call("GET", "", f.cookie)
		return r.State == "acknowledged" && r.Event == hex.EncodeToString(eventID[:]) && r.WithheldMS >= 100 && r.WithheldMS < 10000
	}, time.Second, 10*time.Millisecond)
	// Cancellation of an unused window cannot delay a later event.
	code, _ = call("POST", `{"branch":"`+f.row.ID+`","delay_ms":10000}`, f.cookie)
	require.Equal(t, 200, code)
	code, cancelled := call("POST", `{"branch":"`+f.row.ID+`","delay_ms":0}`, f.cookie)
	require.Equal(t, 200, code)
	require.Equal(t, "cancelled", cancelled.State)
	// The automatic cohort uses the full ten seconds, without an operator restore.
	code, natural := call("POST", `{"branch":"`+f.row.ID+`","delay_ms":10000}`, f.cookie)
	require.Equal(t, 200, code)
	eventID[0] = 92
	start := time.Now()
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(2)), wire.Field(2, eventID[:]), wire.Field(3, payload))}))
	require.NoError(t, peer.SetReadDeadline(time.Now().Add(15*time.Second)))
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, byte(3), frame.Payload[0])
	require.GreaterOrEqual(t, time.Since(start), 10*time.Second)
	require.Eventually(t, func() bool {
		_, r := call("GET", "", f.cookie)
		return r.ID == natural.ID && r.State == "acknowledged" && r.WithheldMS >= 10000 && r.Event == hex.EncodeToString(eventID[:])
	}, time.Second, 10*time.Millisecond)

	// Recheck the production adapter against the actual completed host receipt.
	// The matching guest identity is a wire-peer observation, not VM proof.
	_, completed := call("GET", "", f.cookie)
	adapter, err := filepath.Abs("../../../../scripts/perf/rebase-production.mjs")
	require.NoError(t, err)
	adapterURL := (&url.URL{Scheme: "file", Path: adapter}).String()
	armedJSON, err := json.Marshal(natural)
	require.NoError(t, err)
	completedJSON, err := json.Marshal(completed)
	require.NoError(t, err)
	verifySource := `import {verifyCaptureDelay} from ` + strconv.Quote(adapterURL) + `;
 const armed=JSON.parse(process.argv[1]), receipt=JSON.parse(process.argv[2]);
 const hold={branch:armed.branch,clock:"guest monotonic:"+armed.boot,
 capture:{boot:receipt.boot,event:receipt.event,sequence:receipt.sequence},
 acknowledgedBeforeThaw:false,localSnapshotQueued:true};
 verifyCaptureDelay(receipt,hold,armed);
 for(const change of [{branch:"foreign"},{id:"old-window"},{boot:"old-boot"}]){
 let rejected=false;try{verifyCaptureDelay({...receipt,...change},hold,armed)}catch{rejected=true}
 if(!rejected)throw new Error("foreign receipt accepted");
 }`
	verifyCommand := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", verifySource, string(armedJSON), string(completedJSON))
	verifyOutput, err := verifyCommand.CombinedOutput()
	require.NoError(t, err, "%s", verifyOutput)

	// Exercise the script's actual authenticated client against this composed
	// install, rather than substituting fetch or testing only a receipt parser.
	module, err := filepath.Abs("../../../.." + "/scripts/perf/lib/ack-delay.mjs")
	require.NoError(t, err)
	moduleURL := (&url.URL{Scheme: "file", Path: module}).String()
	source := `import {acknowledgementDelay} from ` + strconv.Quote(moduleURL) + `;
 const client = acknowledgementDelay({origin:process.argv[1],branch:process.argv[2],cookie:process.argv[3]});
 const armed=await client.arm(10000); const read=await client.read();
 if(read.id!==armed.id||read.state!=="armed")throw new Error("wrong armed window");
 const restored=await client.arm(0); if(restored.state!=="cancelled")throw new Error("restore failed");`
	cmd := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", source, f.origin, f.row.ID, "session="+f.cookie+"; __csrf=perf-csrf")
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, "%s", output)

}
