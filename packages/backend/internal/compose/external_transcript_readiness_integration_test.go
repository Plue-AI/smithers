package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

func TestInstallTranscriptProvidersFenceDiscoveryAtAuthenticatedRoster(t *testing.T) {
	f := presenceInstall(t)
	_, err := f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin',$3,20001) ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET unix_login=$3,unix_uid=20001`, f.row.RepositoryID, f.user.ID, f.user.Username)
	require.NoError(t, err)

	registry := new(machined.Registry)
	registry.BindSessionIdentities(newMachineHost(f.pool, nil))
	link, peer := presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, link.Reconciled())
	store, err := chat.NewStore(f.pool)
	require.NoError(t, err)
	adapter := &countingTranscriptAdapter{HTTPChatHost: packagedTranscriptHost(t)}
	ingest := &TranscriptIngest{Store: store, Host: adapter}
	presence := &branchPresence{hosts: f.p.hosts, queries: f.p.queries, branches: f.p.branches, dispatcher: f.p.dispatcher, visits: f.p.visits}
	presence.sourcesReady = presence.sourceCensus(f.bus, registry)
	history := func(ctx context.Context, member int64, branch string) (json.RawMessage, error) {
		entries, err := store.SharedEntries(ctx, chat.Scope{RepositoryID: f.row.RepositoryID, UserID: member}, branch)
		if err != nil {
			return nil, err
		}
		return json.Marshal(entries)
	}
	providers := transcriptImportProviders{ReceiptStore: f.pool, Ingest: ingest, Presence: presence, Live: f.liveHandler, Revocation: f.bus, History: history}
	f.topics.conversation = history
	// Read the real store through the authenticated install live socket. No
	// seeded conversation or new ingestion store is introduced by readiness.
	browser := f.dial(t)
	sendPresenceFrame(t, browser, `{"t":"sub","id":1,"topic":"conversation:`+f.row.ID+`"}`)
	require.Equal(t, "snap", readPresenceFrame(t, browser).T)
	sendRoster := func(enabled bool) {
		done := make(chan error, 1)
		go func() {
			done <- registry.SetRoster(t.Context(), f.row.ID, []machined.SessionUser{{Login: f.user.Username, UID: 20001}})
		}()
		request, err := wire.Read(peer)
		require.NoError(t, err)
		id, method, body, err := request.Request()
		require.NoError(t, err)
		require.Equal(t, byte(wire.SetRoster), method)
		fields, err := wire.Fields("args16", body)
		require.NoError(t, err)
		if enabled {
			require.Equal(t, []byte{1}, fields[2])
		} else {
			require.Nil(t, fields[2], "unavailable import must never grant discovery")
		}
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.SetRoster))))}))
		require.NoError(t, <-done)
	}
	// Startup is off even with identities; positive composition enables it.
	sendRoster(false)
	providers.bind(registry)
	t.Run("event-writer", func(t *testing.T) { sendRoster(false) })
	// The real event pump is composed, but this test supplies no durable
	// records: repository requests or normalization would be a defect.
	repository := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected repository request %s", r.URL.Path)
		http.Error(w, "unexpected", 500)
	}))
	defer repository.Close()
	host := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repository.URL}, "test")
	stopEvents, err := (machineEvents{Transcripts: ingest}).bind(t.Context(), registry, f.pool, host, nil, nil)
	require.NoError(t, err)
	defer stopEvents()
	providers.bind(registry)
	sendRoster(true)
	var seq uint64
	for _, missing := range []string{"receipt-store", "ingest", "conversation-store", "adapter", "presence", "dispatcher", "member-authority", "member-store", "presence-census", "live", "live-hub", "live-store", "live-topics", "live-presence", "revocation", "history", "session-identities"} {
		t.Run(missing, func(t *testing.T) {
			p := providers
			i := *ingest
			p.Ingest = &i
			roster := &branchPresence{hosts: presence.hosts, queries: presence.queries, branches: presence.branches, dispatcher: presence.dispatcher, visits: presence.visits, sourcesReady: presence.sourcesReady}
			p.Presence = roster
			live := *f.liveHandler
			p.Live = &live
			switch missing {
			case "receipt-store":
				p.ReceiptStore = nil
			case "ingest":
				p.Ingest = nil
			case "conversation-store":
				i.Store = nil
			case "adapter":
				i.Host = nil
			case "presence":
				p.Presence = nil
			case "dispatcher":
				roster.dispatcher = nil
			case "member-authority":
				roster.branches = nil
			case "member-store":
				roster.queries = nil
			case "presence-census":
				roster.sourcesReady = nil
			case "live":
				p.Live = nil
			case "live-hub":
				live.Hub = nil
			case "live-store":
				live.Queries = nil
			case "live-topics":
				live.Topics = nil
			case "live-presence":
				live.Presence = nil
			case "revocation":
				p.Revocation = nil
			case "history":
				p.History = nil
			case "session-identities":
				registry.BindSessionIdentities(nil)
			}
			p.bind(registry)
			sendRoster(false)
			outcome, _, err := deliverTranscript(peer, &seq, wire.Transcript{Version: 1, Session: 1, Participant: [16]byte(uuid.New()), Source: [16]byte(uuid.New()), Profile: "codex/0.160.0", Generation: 1, Start: 0, End: 3, Record: "{}"})
			require.NoError(t, err)
			require.Equal(t, machined.AckRejected, outcome)
			require.Zero(t, adapter.calls, "unavailable providers must fence normalization")
			registry.BindSessionIdentities(newMachineHost(f.pool, nil))
			providers.bind(registry)
			sendRoster(true)
		})
	}
	registry.BindTranscriptImport(false)
	sendRoster(false)
	var entries, receipts, checkpoints int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM chat_turns`).Scan(&entries))
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts WHERE transcript_checkpoint IS NOT NULL OR capture_payload IS NOT NULL`).Scan(&checkpoints))
	require.Zero(t, checkpoints)
	require.Zero(t, entries)
	require.Equal(t, 17, receipts, "only rejected transport envelopes are settled")
}
