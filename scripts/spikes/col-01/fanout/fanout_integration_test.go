package fanout

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/col01/measure"
)

// This test uses the actual host-built Rust binary and Yrs document. Real Yjs
// creates the UTF8 edits; the browser suite separately exercises its observers.
func TestRealDocumentHostFanoutResetAndDisk(t *testing.T) {
	f := startDocumentHost(t)
	requestStatus(t, http.MethodPost, f.http.URL+"/reset?room=first", http.StatusNoContent)
	a, initialA := f.dial(t, "first")
	b, initialB := f.dial(t, "first")
	if initialA.Kind != "init" || initialA.Update == "" || initialA.Update != initialB.Update {
		t.Fatalf("invalid or inconsistent guest snapshots: %+v, %+v", initialA, initialB)
	}
	if update, err := base64.StdEncoding.DecodeString(initialA.Update); err != nil || len(update) == 0 {
		t.Fatalf("initial snapshot is not a nonempty binary Yrs update: %v", err)
	}
	requestStatus(t, http.MethodGet, f.http.URL+"/reset", http.StatusMethodNotAllowed)
	requestStatus(t, http.MethodPost, f.http.URL+"/reset?room=rejected", http.StatusConflict)
	baseline := getStats(t, f.http.URL).Update
	edits := originalYjsEdits(t, f.ctx, initialA.Update)
	if len(edits.Updates) != 2 || edits.Text == baseline {
		t.Fatal("real Yjs did not produce two original edits")
	}

	// Both clients write through the same real persistent guest connection.
	for index, sender := range []*websocket.Conn{a, b} {
		want := Message{Kind: "update", Seq: uint64(index + 1), Update: edits.Updates[index]}
		data, err := json.Marshal(want)
		if err != nil {
			t.Fatal(err)
		}
		if err := sender.Write(f.ctx, websocket.MessageText, data); err != nil {
			t.Fatal(err)
		}
		for _, receiver := range []*websocket.Conn{a, b} {
			got := readMessage(t, f.ctx, receiver)
			if got.Kind != want.Kind || got.Seq != want.Seq || got.Update != want.Update {
				t.Fatalf("broadcast = %+v; want %+v", got, want)
			}
			in := positiveTimestamp(t, got.HostIn)
			out := positiveTimestamp(t, got.HostOut)
			positiveTimestamp(t, got.HostVMNS)
			if in > out || got.HostInElapsedNS != got.HostIn {
				t.Fatalf("invalid host timing order: %+v", got)
			}
		}
	}

	// Wait for the real 200ms save debounce, inspecting guest receipts rather
	// than assuming an accepted update has already reached disk.
	var stats Message
	deadline := time.Now().Add(3 * time.Second)
	for {
		stats = getStats(t, f.http.URL)
		if stats.Saves > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("guest never completed a debounced save")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if stats.SaveNS == 0 || stats.Update != edits.Text || stats.Update != "Δ test\n雪🙂 café\n"+baseline {
		t.Fatalf("invalid real guest save receipt: %+v", stats)
	}
	disk, err := os.ReadFile(f.path)
	if err != nil {
		t.Fatal(err)
	}
	if string(disk) != stats.Update {
		t.Fatal("guest snapshot differs from actual persisted file")
	}
	response, err := http.Get(f.http.URL + "/disk")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || string(body) != string(disk) {
		t.Fatalf("/disk = %d, %q, %v; want actual file", response.StatusCode, body, err)
	}

	a.CloseNow()
	b.CloseNow()
	deadline = time.Now().Add(3 * time.Second)
	for {
		response, err := http.Post(f.http.URL+"/reset?room=second", "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode == http.StatusNoContent {
			break
		}
		if response.StatusCode != http.StatusConflict || time.Now().After(deadline) {
			t.Fatalf("reset after disconnect = %d", response.StatusCode)
		}
		time.Sleep(10 * time.Millisecond)
	}
	stats = getStats(t, f.http.URL)
	if stats.Saves != 0 || stats.SaveNS != 0 || stats.Update != baseline {
		t.Fatalf("reset did not restore guest state and counters: %+v", stats)
	}
	old, _, err := websocket.Dial(f.ctx, strings.Replace(f.http.URL, "http://", "ws://", 1)+"/ws?room=first", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer old.CloseNow()
	if _, _, err := old.Read(f.ctx); err == nil {
		t.Fatal("old room received initialization after reset")
	}
	_, initial := f.dial(t, "second")
	if initial.Kind != "init" || initial.Update != initialA.Update {
		t.Fatal("new room was not initialized from real reset guest")
	}
	if err := os.Remove(f.path); err != nil {
		t.Fatal(err)
	}
	requestStatus(t, http.MethodGet, f.http.URL+"/disk", http.StatusInternalServerError)
	requestStatus(t, http.MethodGet, f.http.URL+"/missing", http.StatusNotFound)
}

type yjsEdits struct {
	Updates []string `json:"updates"`
	Text    string   `json:"text"`
}

func originalYjsEdits(t *testing.T, ctx context.Context, initial string) yjsEdits {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate installed Yjs dependency")
	}
	modulePath := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../apps/app/node_modules/yjs/dist/yjs.mjs"))
	moduleURL := (&url.URL{Scheme: "file", Path: modulePath}).String()
	const script = `
const Y = await import(process.argv[1]);
const doc = new Y.Doc();
doc.clientID = 2;
Y.applyUpdate(doc, new Uint8Array(Buffer.from(process.argv[2], "base64")));
const text = doc.getText("content");
const updates = [];
for (const prefix of ["雪🙂 café\n", "Δ test\n"]) {
  const before = Y.encodeStateVector(doc);
  text.insert(0, prefix);
  updates.push(Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64"));
}
process.stdout.write(JSON.stringify({ updates, text: text.toString() }));
`
	output, err := exec.CommandContext(ctx, "node", "--input-type=module", "-e", script, moduleURL, initial).Output()
	if err != nil {
		t.Fatalf("real Yjs edit generation: %v: %s", err, output)
	}
	var edits yjsEdits
	if err := json.Unmarshal(output, &edits); err != nil {
		t.Fatal(err)
	}
	return edits
}

type documentFixture struct {
	ctx  context.Context
	http *httptest.Server
	path string
}

func startDocumentHost(t *testing.T) documentFixture {
	t.Helper()
	binary := os.Getenv("COL01_DOCHOST_BINARY")
	if binary == "" {
		t.Fatal("COL01_DOCHOST_BINARY is required: build the real host col01-dochost binary first")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	dir := t.TempDir()
	path := filepath.Join(dir, "source.ts")
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	log, err := os.Create(filepath.Join(dir, "guest.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { log.Close() })
	cmd := exec.CommandContext(ctx, binary, "dial", listener.Addr().String(), path)
	cmd.Stdout = log
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
		if t.Failed() {
			data, _ := os.ReadFile(log.Name())
			t.Logf("real dochost log: %s", data)
		}
	})
	if err := listener.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	guest, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { guest.Close() })
	if err := guest.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	marker, err := measure.ReadFrame(guest)
	if err != nil || string(marker) != "col01-dochost" {
		t.Fatalf("real guest handshake = %q, %v", marker, err)
	}
	if err := guest.SetDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	server := New(ctx, guest, func(context.Context) ([]byte, error) { return os.ReadFile(path) }, map[string]string{"integration": "real-host-yrs"}, filepath.Join(dir, "unused.js"))
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return documentFixture{ctx: ctx, http: httpServer, path: path}
}

func (f documentFixture) dial(t *testing.T, room string) (*websocket.Conn, Message) {
	t.Helper()
	conn, _, err := websocket.Dial(f.ctx, strings.Replace(f.http.URL, "http://", "ws://", 1)+"/ws?room="+room, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn, readMessage(t, f.ctx, conn)
}

func readMessage(t *testing.T, ctx context.Context, conn *websocket.Conn) Message {
	t.Helper()
	typ, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("unexpected websocket message type: %v", typ)
	}
	var message Message
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatal(err)
	}
	return message
}

func requestStatus(t *testing.T, method, url string, want int) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != want {
		t.Fatalf("%s %s = %d; want %d", method, url, response.StatusCode, want)
	}
}

func getStats(t *testing.T, url string) Message {
	t.Helper()
	response, err := http.Get(url + "/stats")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stats HTTP status: %d", response.StatusCode)
	}
	var stats Message
	if err := json.NewDecoder(response.Body).Decode(&stats); err != nil {
		t.Fatal(err)
	}
	if stats.Kind != "stats" {
		t.Fatalf("unexpected stats response: %+v", stats)
	}
	return stats
}

func positiveTimestamp(t *testing.T, value string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n <= 0 {
		t.Fatalf("invalid nanoseconds %q: %v", value, err)
	}
	return n
}
