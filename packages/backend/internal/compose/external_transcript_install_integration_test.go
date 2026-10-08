package compose

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// recordedTranscript is a capture the named CLI wrote, as the lines the
// machine's reader would frame.
func recordedTranscript(t *testing.T, directory, file string) []string {
	t.Helper()
	_, source, _, ok := goruntime.Caller(0)
	require.True(t, ok)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	data, err := os.ReadFile(filepath.Join(root, "packages/smithers/agent/harness/test/fixtures/external", directory, file))
	require.NoError(t, err)
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

// The install's own event pump imports the Codex and Claude Code sessions two
// members run in their terminals on one branch machine (mvp.md M-38, C-AGT-02).
//
// Production here: the consumer install main.go mounts, daemon authentication
// and framing, the host's durable session receipts (machineHost.Record), the
// packaged TypeScript adapters over HTTP, the receipt transaction, the chat
// journal, both members' browser history routes and a running dispatcher.
// Scripted: the daemon's side of the link, sending records real CLIs wrote.
func TestInstallTranscriptPumpImportsMembersOwnSessions(t *testing.T) {
	fixture := newTranscriptImportFixture(t)
	pool, ctx, branch := fixture.pool, t.Context(), fixture.branch.ID
	adapter := &countingTranscriptAdapter{HTTPChatHost: packagedTranscriptHost(t)}
	transcripts, err := installTranscripts(pool, adapter)
	require.NoError(t, err)
	require.NotNil(t, transcripts)
	repository := repohost.NewLocalClient(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a transcript reached the repository host")
	}), "transcripts")
	stop, err := machineEvents{Transcripts: transcripts}.bind(ctx, fixture.registry, pool, repository, nil, nil)
	require.NoError(t, err)
	t.Cleanup(stop)
	sessions := newMachineHost(pool, repository)

	connect := func(authority machined.BootAuthority) (*machined.Link, net.Conn) {
		link, peer := externalTranscriptLink(t, fixture.registry, branch, authority)
		require.NoError(t, peer.SetDeadline(time.Now().Add(60*time.Second)))
		return link, peer
	}
	link, peer := connect(fixture.authority)
	// The host opens a terminal session for a member and keeps that receipt.
	open := func(link *machined.Link, session uint32, member db.User, via string) {
		t.Helper()
		var uid uint32
		require.NoError(t, pool.QueryRow(ctx, `SELECT unix_uid FROM collaborators WHERE user_id=$1`, member.ID).Scan(&uid))
		require.NoError(t, sessions.Record(ctx, branch, link.BootID(), session, machined.SessionUser{Login: member.Username, UID: uid}, via))
	}
	var seq uint64
	// process is one agent process the machine's broker discovered: its
	// session, participant, source lifetime and profile, and its file offset.
	type process struct {
		session             uint32
		participant, source [16]byte
		profile             string
		generation, offset  uint64
	}
	deliver := func(peer net.Conn, p *process, record string) (machined.AckOutcome, error) {
		end := p.offset + uint64(len(record)) + 1
		outcome, _, err := deliverTranscript(peer, &seq, wire.Transcript{Version: 1, Session: p.session, Participant: p.participant, Source: p.source, Profile: p.profile, Generation: p.generation, Start: p.offset, End: end, Record: record})
		if err == nil && outcome == machined.AckApplied {
			p.offset = end
		}
		return outcome, err
	}
	importAll := func(p *process, records []string) {
		t.Helper()
		for index, record := range records {
			outcome, err := deliver(peer, p, record)
			require.NoError(t, err, "record %d", index+1)
			require.Equal(t, machined.AckApplied, outcome, "record %d", index+1)
		}
	}
	external := func(cookie string) (entries []externalMessage) {
		for _, entry := range fixture.history(t, cookie) {
			if entry.Origin == "external" {
				entries = append(entries, entry)
			}
		}
		return
	}
	count := func(query string, args ...any) (n int) {
		t.Helper()
		require.NoError(t, pool.QueryRow(ctx, query, args...).Scan(&n))
		return
	}

	// Ben's terminal runs Codex, then Claude Code. Maya (alice) is on SSH with
	// her own Codex. Each process is its own participant.
	open(link, 1, fixture.ben, "terminal")
	open(link, 2, fixture.alice, "ssh")
	benCodex := &process{session: 1, participant: [16]byte{0xb1}, source: [16]byte{0xc1}, profile: "codex-rollout/0.160", generation: 1}
	benClaude := &process{session: 1, participant: [16]byte{0xb2}, source: [16]byte{0xc2}, profile: "claude-code/2.1", generation: 1}
	aliceCodex := &process{session: 2, participant: [16]byte{0xa1}, source: [16]byte{0xd1}, profile: "codex-rollout/0.160", generation: 1}
	importAll(benCodex, recordedTranscript(t, "codex-machine-0.160", "rollout.jsonl"))
	importAll(benClaude, recordedTranscript(t, "claude-code-signed-out-2.1", "session.jsonl"))
	importAll(aliceCodex, recordedTranscript(t, "codex-signed-out-0.160", "rollout.jsonl"))

	id := func(value [16]byte) string { return uuid.UUID(value).String() }
	for _, cookie := range []string{fixture.benCookie, fixture.aliceCookie} {
		entries := external(cookie)
		require.Len(t, entries, 12+2+2)
		type line struct{ participant, agent, role, actor, member, status string }
		lines := make([]line, len(entries))
		for index, entry := range entries {
			require.True(t, entry.ReadOnly)
			member := entry.Actor.ForMember.Login
			if entry.Actor.Kind == "person" {
				member = entry.Actor.Login
			}
			lines[index] = line{entry.Participant, entry.Agent, entry.Role, entry.Actor.Kind, member, entry.Status}
		}
		// The member-machine Codex capture: two prompts are Ben's, the rest is
		// his Codex participant's, and the failed script and edit and the
		// command that exited 7 are failed.
		ben, codex := line{id(benCodex.participant), "codex", "user", "person", "ben", "complete"}, line{id(benCodex.participant), "codex", "smithers", "agent", "ben", "complete"}
		failed := codex
		failed.status = "failed"
		require.Equal(t, []line{ben, codex, codex, codex, codex, codex, ben, codex, failed, failed, failed, codex}, lines[:12])
		// The same terminal's Claude Code is another participant of Ben's.
		require.Equal(t, []line{
			{id(benClaude.participant), "claude-code", "user", "person", "ben", "complete"},
			{id(benClaude.participant), "claude-code", "smithers", "agent", "ben", "failed"},
		}, lines[12:14])
		require.Equal(t, "Not logged in · Please run /login", entries[13].Text)
		// Maya's session is hers: her prompt, her Codex.
		require.Equal(t, []line{
			{id(aliceCodex.participant), "codex", "user", "person", "alice", "complete"},
			{id(aliceCodex.participant), "codex", "smithers", "agent", "alice", "failed"},
		}, lines[14:])
		require.Equal(t, "Create sample.txt containing the word alpha, then print it.", entries[14].Text)
		require.Contains(t, entries[15].Text, "401 Unauthorized")
		// The agent's own session ids are data: nothing is filed under them.
		require.Equal(t, "01a1149b-f90c-7833-87d0-6c4ff981df9c:10", entries[0].SourceID)
	}
	imported := 46 + 19 + 11
	require.Equal(t, imported, count(`SELECT count(*) FROM machine_event_receipts WHERE outcome='applied'`))
	require.Equal(t, imported, adapter.calls)
	// Every committed checkpoint carries the registration it committed under.
	require.Equal(t, imported, count(`SELECT count(*) FROM machine_event_receipts WHERE transcript_checkpoint->>'boot'=$1 AND transcript_checkpoint->>'owner' IN ($2,$3)`,
		hex.EncodeToString(func() []byte { boot := link.BootID(); return boot[:] }()), fmt.Sprint(fixture.ben.ID), fmt.Sprint(fixture.alice.ID)))

	// What can never be this install's to import settles as rejected, with no
	// entry, no adapter call and no change to what either member reads.
	before := external(fixture.aliceCookie)
	skip := `{"type":"turn_context","payload":{}}`
	agentRun := uuid.NewString()
	require.NoError(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		data, err := json.Marshal(map[string]any{"boot": hex.EncodeToString(func() []byte { boot := link.BootID(); return boot[:] }()), "session": 3, "login": "agent", "uid": 19999, "member_id": fixture.ben.ID, "via": "agent:" + agentRun})
		require.NoError(t, err)
		_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(fixture.repo.ID), PrincipalID: "branch:" + branch}, uuid.NewString(), "branch.session_opened", "completed", data)
		return err
	}))
	for _, tc := range []struct {
		name    string
		process process
	}{
		{"another member's session naming Ben's source", process{session: 2, participant: benCodex.participant, source: benCodex.source, profile: benCodex.profile, generation: 1, offset: benCodex.offset}},
		{"Ben's source under another participant", process{session: 1, participant: [16]byte{0xee}, source: benCodex.source, profile: benCodex.profile, generation: 1, offset: benCodex.offset}},
		{"Ben's source under another profile", process{session: 1, participant: benCodex.participant, source: benCodex.source, profile: "codex-rollout/0.159", generation: 1, offset: benCodex.offset}},
		{"Ben's source in a replaced generation under Maya's session", process{session: 2, participant: benCodex.participant, source: benCodex.source, profile: benCodex.profile, generation: 2}},
		{"a coding run's session", process{session: 3, participant: [16]byte{0xf1}, source: [16]byte{0xf2}, profile: "codex-rollout/0.160", generation: 1}},
		{"a record that skips ahead in Ben's file", process{session: 1, participant: benCodex.participant, source: benCodex.source, profile: benCodex.profile, generation: 1, offset: benCodex.offset + 99}},
	} {
		t.Run("rejects "+tc.name, func(t *testing.T) {
			calls := adapter.calls
			outcome, err := deliver(peer, &tc.process, skip)
			require.NoError(t, err)
			require.Equal(t, machined.AckRejected, outcome)
			require.Equal(t, calls, adapter.calls)
			require.Equal(t, before, external(fixture.aliceCookie))
			require.Equal(t, imported, count(`SELECT count(*) FROM machine_event_receipts WHERE outcome='applied'`))
		})
	}
	// Ben's real next record still imports: none of the forgeries moved his source.
	outcome, err := deliver(peer, benCodex, skip)
	require.NoError(t, err)
	require.Equal(t, machined.AckApplied, outcome)
	imported++

	// A session the host has no receipt for is not answered: the link closes
	// with nothing committed, and the record stays with the daemon.
	receipts := count(`SELECT count(*) FROM machine_event_receipts`)
	unknown := process{session: 9, participant: [16]byte{0x91}, source: [16]byte{0x92}, profile: "codex-rollout/0.160", generation: 1}
	_, err = deliver(peer, &unknown, skip)
	require.Error(t, err, "a session the host never opened was acknowledged")
	select {
	case <-link.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("the install pump kept a link whose record it could not place")
	}
	require.Equal(t, receipts, count(`SELECT count(*) FROM machine_event_receipts`))
	require.Equal(t, before, external(fixture.benCookie))
	// The daemon reconnects on the same boot and the host opens that session:
	// the same record now imports. Nothing was lost by waiting.
	link, peer = connect(fixture.authority)
	open(link, 9, fixture.alice, "terminal")
	outcome, err = deliver(peer, &unknown, `{"timestamp":"2026-10-08T05:00:00.000Z","type":"session_meta","payload":{"id":"late","cwd":"/workspace","cli_version":"0.160.1"}}`)
	require.NoError(t, err)
	require.Equal(t, machined.AckApplied, outcome)
	imported++

	// Ben is removed from the repository. His agent's next records are dropped,
	// before the adapter sees them; what he already shared stays for Maya.
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, fixture.ben.ID)
	require.NoError(t, err)
	calls := adapter.calls
	for range 2 {
		outcome, err = deliver(peer, benCodex, skip)
		require.NoError(t, err)
		require.Equal(t, machined.AckRejected, outcome)
	}
	outcome, err = deliver(peer, benClaude, `{"type":"mode","mode":"default"}`)
	require.NoError(t, err)
	require.Equal(t, machined.AckRejected, outcome)
	require.Equal(t, calls, adapter.calls)
	require.Equal(t, before, external(fixture.aliceCookie))
	// Maya's own session is unaffected.
	outcome, err = deliver(peer, aliceCodex, skip)
	require.NoError(t, err)
	require.Equal(t, machined.AckApplied, outcome)
	imported++
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`, fixture.ben.ID)
	require.NoError(t, err)

	// The machine boots again. Session numbers start over: session 1 is now
	// Maya's. A record the old daemon still held for Ben's source is not hers,
	// and a source of the old boot never continues on the new one.
	rebooted, err := fixture.registry.MintBoot(branch, "vm-external")
	require.NoError(t, err)
	link, peer = connect(rebooted)
	open(link, 1, fixture.alice, "terminal")
	stale := *benCodex
	outcome, err = deliver(peer, &stale, skip)
	require.NoError(t, err)
	require.Equal(t, machined.AckRejected, outcome)
	fresh := &process{session: 1, participant: [16]byte{0xa2}, source: [16]byte{0xd2}, profile: "claude-code/2.1", generation: 1}
	importAll(fresh, recordedTranscript(t, "claude-code-signed-out-2.1", "session.jsonl"))
	imported += 19
	entries := external(fixture.benCookie)
	require.Len(t, entries, len(before)+2)
	require.Equal(t, "alice", entries[len(entries)-2].Actor.Login)
	require.Equal(t, "alice", entries[len(entries)-1].Actor.ForMember.Login)
	require.Equal(t, imported, count(`SELECT count(*) FROM machine_event_receipts WHERE outcome='applied'`))

	// A machine on main has no conversation of its own: what an agent says
	// there is read where members read and write main's.
	var machines int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM users WHERE username='smithers-machines'`).Scan(&machines))
	onMain, err := db.New(pool).CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: fixture.repo.ID, UserID: machines, Name: "main-machine", TargetBookmark: "main", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	mainBoot, err := fixture.registry.MintBoot(onMain.ID, "vm-main")
	require.NoError(t, err)
	mainLink, mainPeer := externalTranscriptLink(t, fixture.registry, onMain.ID, mainBoot)
	require.NoError(t, mainPeer.SetDeadline(time.Now().Add(60*time.Second)))
	var uid uint32
	require.NoError(t, pool.QueryRow(ctx, `SELECT unix_uid FROM collaborators WHERE user_id=$1`, fixture.ben.ID).Scan(&uid))
	require.NoError(t, sessions.Record(ctx, onMain.ID, mainLink.BootID(), 1, machined.SessionUser{Login: "ben", UID: uid}, "terminal"))
	mainClaude := &process{session: 1, participant: [16]byte{0xb9}, source: [16]byte{0xc9}, profile: "claude-code/2.1", generation: 1}
	for index, record := range recordedTranscript(t, "claude-code-signed-out-2.1", "session.jsonl") {
		outcome, err := deliver(mainPeer, mainClaude, record)
		require.NoError(t, err, "record %d", index+1)
		require.Equal(t, machined.AckApplied, outcome, "record %d", index+1)
	}
	imported += 19
	var onMainEntries []externalMessage
	var read struct {
		Entries []externalMessage `json:"entries"`
	}
	require.NoError(t, json.Unmarshal([]byte(fixture.call("GET", "/api/conversations/main", "", fixture.aliceCookie, 200)), &read))
	for _, entry := range read.Entries {
		if entry.Origin == "external" {
			onMainEntries = append(onMainEntries, entry)
		}
	}
	require.Len(t, onMainEntries, 2)
	require.Equal(t, "Create sample.txt containing the word alpha, then print it.", onMainEntries[0].Text)
	require.Equal(t, id(mainClaude.participant), onMainEntries[1].Participant)
	require.Equal(t, "ben", onMainEntries[1].Actor.ForMember.Login)
	// The branch's own conversation did not gain them.
	require.Len(t, external(fixture.benCookie), len(entries))
	entries = append(entries, onMainEntries...)

	// Importing queued no turn, ran nothing, and left every entry terminal and
	// refused to both members' mutations.
	select {
	case grant := <-fixture.host.started:
		t.Fatalf("an import launched app-agent turn %s", grant.TurnID)
	default:
	}
	require.Zero(t, count(`SELECT count(*) FROM chat_turns WHERE NOT terminal`))
	require.Equal(t, len(entries), count(`SELECT count(*) FROM chat_turns WHERE request_payload->>'origin'='external'`))
	var turn string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM chat_turns WHERE request_payload->'external'->>'kind'='tool_result' LIMIT 1`).Scan(&turn))
	for _, cookie := range []string{fixture.benCookie, fixture.aliceCookie} {
		fixture.call("PATCH", "/api/conversations/"+branch+"/turns/"+turn, `{"prompt":"run it again"}`, cookie, 403)
		fixture.call("POST", "/api/conversations/"+branch+"/turns/"+turn+"/stop", "{}", cookie, 403)
		fixture.call("DELETE", "/api/conversations/"+branch+"/turns/"+turn, "", cookie, 403)
	}
}

// A deployment whose chat host cannot run the adapters composes no transcript
// import, and the pump refuses a transcript before it reads or stores anything.
func TestInstallTranscriptsRequireTheAdapterHost(t *testing.T) {
	fixture := newTranscriptImportFixture(t)
	transcripts, err := installTranscripts(fixture.pool, fixture.host)
	require.NoError(t, err)
	require.Nil(t, transcripts, "a chat host without the transcript adapters must not compose an import")
	transcripts, err = installTranscripts(nil, &countingTranscriptAdapter{})
	require.NoError(t, err)
	require.Nil(t, transcripts)

	repository := repohost.NewLocalClient(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("an unavailable transcript reached the repository host")
	}), "transcripts")
	stop, err := machineEvents{}.bind(t.Context(), fixture.registry, fixture.pool, repository, nil, nil)
	require.NoError(t, err)
	t.Cleanup(stop)
	link, peer := externalTranscriptLink(t, fixture.registry, fixture.branch.ID, fixture.authority)
	require.NoError(t, peer.SetDeadline(time.Now().Add(3*time.Second)))
	var seq uint64
	_, _, err = deliverTranscript(peer, &seq, wire.Transcript{Version: 1, Session: 1, Participant: [16]byte{1}, Source: [16]byte{2}, Profile: "claude-code/2.1", Generation: 1, End: 3, Record: "{}"})
	require.Error(t, err, "an unavailable import was acknowledged")
	select {
	case <-link.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("the pump kept a link whose transcript it cannot import")
	}
	var rows int
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM machine_event_receipts)+(SELECT count(*) FROM chat_turns)`).Scan(&rows))
	require.Zero(t, rows)
}
