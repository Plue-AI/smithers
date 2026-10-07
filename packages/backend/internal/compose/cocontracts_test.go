package compose

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined/testfake"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type wireManifest struct {
	Frames []struct {
		Name, Expected, SHA256 string
		Local                  bool
	}
	Sequences map[string][]string
}

func wireFixtures(t *testing.T) wireManifest {
	t.Helper()
	b, e := os.ReadFile("testdata/cocontracts/MANIFEST.json")
	if e != nil {
		t.Fatal(e)
	}
	var m wireManifest
	if e = json.Unmarshal(b, &m); e != nil {
		t.Fatal(e)
	}
	if len(m.Frames) < 100 {
		t.Fatal("missing daemon corpus")
	}
	return m
}
func wireBytes(t *testing.T, name string) []byte {
	t.Helper()
	b, e := os.ReadFile("testdata/cocontracts/" + name + ".bin")
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestMachinedWireGoldenFrames(t *testing.T) {
	m := wireFixtures(t)
	for _, tc := range m.Frames {
		if tc.Expected != "ok" {
			continue
		}
		t.Run(tc.Name, func(t *testing.T) {
			b := wireBytes(t, tc.Name)
			if fmt.Sprintf("%x", sha256.Sum256(b)) != tc.SHA256 {
				t.Fatal("fixture digest")
			}
			var f wire.Frame
			var e error
			if tc.Local {
				f, e = wire.DecodeLocal(b)
			} else {
				f, e = wire.Decode(b)
			}
			if e != nil {
				t.Fatal(e)
			}
			var value struct {
				Kind    byte
				Stream  uint32
				Payload string
			}
			j, e := os.ReadFile("testdata/cocontracts/" + tc.Name + ".json")
			if e != nil {
				t.Fatal(e)
			}
			if e = json.Unmarshal(j, &value); e != nil {
				t.Fatal(e)
			}
			literal, e := hex.DecodeString(value.Payload)
			if e != nil {
				t.Fatal(e)
			}
			if f.Kind != value.Kind || f.Stream != value.Stream || !bytes.Equal(f.Payload, literal) {
				t.Fatal("decoded value")
			}
			literalFrame := wire.Frame{Kind: value.Kind, Stream: value.Stream, Payload: literal}
			var got []byte
			if tc.Local {
				got, e = wire.EncodeLocal(literalFrame)
			} else {
				got, e = wire.Encode(literalFrame)
			}
			if e != nil || !bytes.Equal(got, b) {
				t.Fatal("encoded value", e)
			}

		})
	}
	for name, seq := range m.Sequences {
		t.Run(name, func(t *testing.T) {
			var b []byte
			for _, n := range seq {
				b = append(b, wireBytes(t, n)...)
			}
			r := bytes.NewReader(b)
			for _, n := range seq {
				f, e := wire.Read(r)
				if e != nil {
					t.Fatal(e)
				}
				out, e := wire.Encode(f)
				if e != nil || !bytes.Equal(out, wireBytes(t, n)) {
					t.Fatal(n, e)
				}
			}
			if r.Len() != 0 {
				t.Fatal("unread frames")
			}
		})
	}
}
func TestMachinedWireRefusals(t *testing.T) {
	for _, tc := range wireFixtures(t).Frames {
		if tc.Expected == "ok" {
			continue
		}
		t.Run(tc.Name, func(t *testing.T) {
			var e error
			if tc.Local {
				_, e = wire.DecodeLocal(wireBytes(t, tc.Name))
			} else {
				_, e = wire.Decode(wireBytes(t, tc.Name))
			}
			if e == nil || e.Error() != tc.Expected {
				t.Fatalf("got %v want %s", e, tc.Expected)
			}
		})
	}
	b := wireBytes(t, "req_write_file")
	for n := 0; n < len(b); n++ {
		if _, e := wire.Decode(b[:n]); e != wire.Truncated {
			t.Fatalf("cut %d: %v", n, e)
		}
	}
}
func TestWireContentLimit(t *testing.T) {
	if wire.MaxWorkspaceFileBytes != 1048576 {
		t.Fatal("changed content limit")
	}
	if _, e := wire.Decode(wireBytes(t, "content_at_limit")); e != nil {
		t.Fatal(e)
	}
	if _, e := wire.Decode(wireBytes(t, "content_over_limit")); e != wire.BadValue {
		t.Fatal(e)
	}
	if wire.InitialCredit != 262144 {
		t.Fatal("changed initial credit")
	}
}
func TestMachinedSkeletonDisabled(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Fatal("skeleton check requires an unprivileged runner")
	}
	root, e := filepath.Abs("../../../..")
	if e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command("cargo", "build", "--locked", "-p", "smithers-machined", "--bin", "smithers-machined")
	cmd.Dir = root
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("Rust build: %v\n%s", e, out)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	temp := t.TempDir()
	cmd = exec.Command(filepath.Join(root, "target/debug/smithers-machined"), "daemon")
	cmd.Dir = temp
	cmd.Env = append(os.Environ(), "SMITHERS_MACHINED_HOST="+listener.Addr().String())
	out, e := cmd.CombinedOutput()
	if e == nil {
		t.Fatal("skeleton started")
	}
	if exit, ok := e.(*exec.ExitError); !ok || exit.ExitCode() != 78 {
		t.Fatal(e, string(out))
	}
	entries, e := os.ReadDir(temp)
	if e != nil || len(entries) != 0 {
		t.Fatal("hook side effect", e)
	}
	listener.(*net.TCPListener).SetDeadline(time.Now().Add(25 * time.Millisecond))
	if _, e := listener.Accept(); e == nil {
		t.Fatal("unexpected connection")
	}
	cmd = exec.Command("cargo", "test", "--locked", "-p", "smithers-machined", "--test", "golden", "--test", "fake_host")
	cmd.Dir = root
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("Rust codec/dispatcher: %v\n%s", e, out)
	}
}

// replayFake crosses a real duplex byte stream in both directions. The oracle
// is exclusively the committed binary/JSON corpus, never newly encoded bytes.
func replayFake(t *testing.T, names []string, receive func(string) bool) {
	t.Helper()
	steps := make([]testfake.Step, len(names))
	for i, name := range names {
		f, err := wire.Decode(wireBytes(t, name))
		if err != nil {
			t.Fatal(err)
		}
		var literal struct {
			Kind    byte
			Stream  uint32
			Payload string
		}
		b, err := os.ReadFile("testdata/cocontracts/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(b, &literal); err != nil {
			t.Fatal(err)
		}
		payload, err := hex.DecodeString(literal.Payload)
		if err != nil {
			t.Fatal(err)
		}
		if f.Kind != literal.Kind || f.Stream != literal.Stream || !bytes.Equal(f.Payload, payload) {
			t.Fatal(name, "decoded fields")
		}
		steps[i] = testfake.Step{Receive: receive(name), Frame: f}
	}
	host, peer := net.Pipe()
	defer host.Close()
	defer peer.Close()
	host.SetDeadline(time.Now().Add(5 * time.Second))
	peer.SetDeadline(time.Now().Add(5 * time.Second))
	done := make(chan error, 1)
	go func() { done <- testfake.Serve(peer, steps); peer.Close() }()
	var got, want []byte
	for i, name := range names {
		expected := wireBytes(t, name)
		want = append(want, expected...)
		if steps[i].Receive {
			// Exercise the production host encoder, recording exactly what it writes.
			var encoded bytes.Buffer
			if err := wire.Write(&encoded, steps[i].Frame); err != nil {
				t.Fatal(err)
			}
			if _, err := host.Write(encoded.Bytes()); err != nil {
				t.Fatal(err)
			}
			got = append(got, encoded.Bytes()...)
		} else {
			actual := make([]byte, len(expected))
			if _, err := io.ReadFull(host, actual); err != nil {
				t.Fatal(err)
			}
			f, err := wire.Read(bytes.NewReader(actual))
			if err != nil {
				t.Fatal(err)
			}
			if f.Kind != steps[i].Frame.Kind || f.Stream != steps[i].Frame.Stream || !bytes.Equal(f.Payload, steps[i].Frame.Payload) {
				t.Fatal(name, "host decoded fields")
			}
			got = append(got, actual...)
		}
	}
	if !bytes.Equal(got, want) {
		t.Fatal("literal transcript mismatch")
	}
	host.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestMachinedFakeGoldenReplay(t *testing.T) {
	for _, fixture := range wireFixtures(t).Frames {
		if fixture.Expected != "ok" || fixture.Local {
			continue
		}
		for _, receive := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/receive=%t", fixture.Name, receive), func(t *testing.T) {
				replayFake(t, []string{fixture.Name}, func(string) bool { return receive })
			})
		}
	}
}

func TestMachinedFakeFaultReplay(t *testing.T) {
	m := wireFixtures(t)
	for _, name := range []string{"seq_handshake", "seq_write_stale", "seq_capture", "seq_missing_objects", "seq_duplicate_receipt", "seq_reconnect_replay", "seq_reserved_doc_s2", "seq_newer_boot", "seq_wake_objects"} {
		t.Run(name, func(t *testing.T) {
			seq, ok := m.Sequences[name]
			if !ok || len(seq) == 0 {
				t.Fatal("missing contract sequence", name)
			}
			replayFake(t, seq, func(n string) bool {
				return n == "hello_host_proof" || n == "hello_welcome" || n == "goodbye_superseded" || n == "doc_reserved_sync" || n == "obj_host_data" || n == "obj_host_eof" || n == "obj_host_close" || len(n) >= 4 && (n[:4] == "req_" || n[:4] == "ack_")
			})
		})
	}
	t.Run("credential_refusal", func(t *testing.T) {
		replayFake(t, []string{"req_read_file", "err_unauthorized"}, func(n string) bool { return n == "req_read_file" })
	})
	t.Run("handshake_credential_refusal", func(t *testing.T) {
		replayFake(t, []string{"hello_challenge", "hello_host_proof", "goodbye_auth_failed"}, func(n string) bool { return n == "hello_host_proof" || n == "goodbye_auth_failed" })
	})
	t.Run("lost_ack_reconnect", func(t *testing.T) {
		// End the first transport without an ack, then replay the committed
		// reconnect ordering and accept the committed duplicate receipt.
		replayFake(t, []string{"ev_burst"}, func(string) bool { return false })
		replayFake(t, m.Sequences["seq_reconnect_replay"], func(n string) bool { return n == "hello_host_proof" || n == "hello_welcome" })
		replayFake(t, m.Sequences["seq_duplicate_receipt"], func(n string) bool { return n == "ack_duplicate" })
	})
	for _, pair := range [][2]string{{"req_status", "res_status"}, {"req_read_file", "res_read_file"}, {"req_write_file", "res_write_file"}, {"req_capture", "res_capture"}, {"req_wake_reconcile", "res_wake_moved"}, {"req_open_doc", "res_unsupported_open_doc"}, {"req_close_doc", "res_unsupported_close_doc"}} {
		t.Run(pair[0], func(t *testing.T) { replayFake(t, pair[:], func(n string) bool { return n == pair[0] }) })
	}
}

func TestMachinedFakeUnscriptedRefusal(t *testing.T) {
	t.Run("invalid_script_no_io", func(t *testing.T) {
		var stream bytes.Buffer
		valid, err := wire.Decode(wireBytes(t, "res_status"))
		if err != nil {
			t.Fatal(err)
		}
		err = testfake.Serve(&stream, []testfake.Step{{Frame: valid}, {Frame: wire.Frame{Kind: 255}}})
		if !errors.Is(err, wire.UnknownKind) || stream.Len() != 0 {
			t.Fatal("script touched stream before validation", err)
		}
	})
	t.Run("truncated_input", func(t *testing.T) {
		f, err := wire.Decode(wireBytes(t, "req_status"))
		if err != nil {
			t.Fatal(err)
		}
		stream := bytes.NewBuffer(wireBytes(t, "req_status")[:8])
		if err := testfake.Serve(stream, []testfake.Step{{Receive: true, Frame: f}}); !errors.Is(err, wire.Truncated) {
			t.Fatal(err)
		}
	})
	for _, empty := range []bool{true, false} {
		t.Run(fmt.Sprint(empty), func(t *testing.T) {
			host, peer := net.Pipe()
			defer host.Close()
			defer peer.Close()
			host.SetDeadline(time.Now().Add(5 * time.Second))
			peer.SetDeadline(time.Now().Add(5 * time.Second))
			var steps []testfake.Step
			if !empty {
				f, err := wire.Decode(wireBytes(t, "req_status"))
				if err != nil {
					t.Fatal(err)
				}
				steps = []testfake.Step{{Receive: true, Frame: f}}
			}
			done := make(chan error, 1)
			go func() { done <- testfake.Serve(peer, steps); peer.Close() }()
			f, err := wire.Decode(wireBytes(t, "req_capture"))
			if err != nil {
				t.Fatal(err)
			}
			// An exhausted script refuses on the first byte and closes the stream.
			_ = wire.Write(host, f)
			if err := <-done; !errors.Is(err, testfake.ErrUnscripted) {
				t.Fatal(err)
			}
			var b [1]byte
			if n, err := host.Read(b[:]); n != 0 || err != io.EOF {
				t.Fatal("unscripted response", n, err)
			}
		})
	}
}

// I1's public boundary is the daemon wire. Replay the host/daemon exchange
// through the production codecs on a duplex connection, including empty roster.
func TestWorkingTogetherWireContract(t *testing.T) {
	seq := wireFixtures(t).Sequences["seq_working_together"]
	if len(seq) != 10 {
		t.Fatal("missing working-together transcript")
	}
	replayFake(t, seq, func(n string) bool { return n == "doc-input-v2" || len(n) >= 4 && n[:4] == "req_" })
	input, err := wire.DecodeDocumentV2(wireBytes(t, "doc-input-v2")[9:])
	if err != nil {
		t.Fatal(err)
	}
	saved, err := wire.DecodeDocumentV2(wireBytes(t, "doc-saved-v2")[9:])
	if err != nil {
		t.Fatal(err)
	}
	if input.Seq != 0x0102030405060708 || saved.ThroughSeq != input.Seq || !bytes.Equal(input.Actor, []byte("Be")) || !bytes.Equal(saved.Data, []byte{1, 42, 1}) {
		t.Fatal("sequence receipt or actor changed", input, saved)
	}
}

// Row 4 expands committed daemon locations and preserves browser document-line
// coordinates through the composed install. Expected locations are literals.
func TestMachinedPresenceRow4LocationExpansion(t *testing.T) {
	frame, err := wire.Decode(wireBytes(t, "presence_snapshot"))
	if err != nil {
		t.Fatal(err)
	}
	locations, err := frame.PresenceSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(locations) != 2 || locations[0].Session != 1 || locations[0].Path != "a" || locations[1].Session != 2 || locations[1].Path != "" {
		t.Fatalf("row-4 locations: %#v", locations)
	}
	f := presenceInstall(t)
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	readPresenceFrame(t, conn)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"presence","id":2,"where":{"branch":%q,"path":"retry.ts","line":12}}`, f.row.ID))
	snapshot := readPresenceFrame(t, conn)
	var card struct {
		Presence []struct {
			Where struct {
				Kind, Path string
				Line       int64
			}
			Sessions []struct {
				Where struct {
					Kind, Path string
					Line       int64
				}
			}
		}
	}
	if err := json.Unmarshal(snapshot.Data, &card); err != nil {
		t.Fatal(err)
	}
	if len(card.Presence) != 1 {
		t.Fatalf("presence: %s", snapshot.Data)
	}
	person := card.Presence[0]
	if person.Where.Kind != "file" || person.Where.Path != "retry.ts" || person.Where.Line != 12 || len(person.Sessions) != 1 || person.Sessions[0].Where != person.Where {
		t.Fatalf("document coordinates: %s", snapshot.Data)
	}
}
