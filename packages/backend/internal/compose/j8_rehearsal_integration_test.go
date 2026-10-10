package compose

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/live"
)

// The trusted-process runtime addresses its isolated process by workspace ID.
// Resolve that identity from the running runtime, as the microVM adapter does.
func (r *rehearsalReviewRuntime) WorkspaceMachineIdentity(ctx context.Context, id string) (string, error) {
	current, err := r.InspectWorkspace(ctx, id)
	return current.ID, err
}

func (r bindingProcessRuntime) WorkspaceMachineIdentity(ctx context.Context, id string) (string, error) {
	current, err := r.InspectWorkspace(ctx, id)
	return current.ID, err
}

// TestJ8Rehearsal walks journey J8 (mvp.md §5, Memory; C-J8-01 to C-J8-05)
// on the install J1 sets up: a TODO merges and its learning run is admitted
// in the background; the owner and Ben co-edit the decision page over
// /api/live and change the decision; the next related TODO's plan cites the
// edited revision. C-J8-03's Obsidian folder runs last, on the same page.
// The install's pinned learning path is built. This trusted-process adapter
// still lacks learning's admission cancellation and local pinned-source read:
// its coding source resolver requires daemon authority before allocation has
// recorded the learning source. The decision-page row remains unverified here.
// Planning citations require the isolated wiki provider.
// Co-editing uses an owner-authored page independently of learning.
func TestJ8Rehearsal(t *testing.T) {
	// The install's state directory, as localbootstrap gives it: an Obsidian
	// folder inside it is refused. It is created here, not with t.TempDir,
	// whose root newRehearsal keeps short for its sockets.
	state, err := os.MkdirTemp("", "j8state")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(state) })
	t.Setenv("SMITHERS_INSTALL_STATE_DIR", state)
	r := newRehearsal(t, "SMITHERS_J8_REHEARSAL", "C-J8", "j8-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	var todo int64
	var item, squash string
	// J8.2 and the Obsidian folder use a page of their own: a failed merge
	// blocks only the learning rows.
	r.step("1 TODO merges", "POST /api/todos [FILE retry.md]; POST /api/todos/{n}/merge", "in_review with merge ready; merged after GitHub's squash; install main follows", "T-STK-04", func() error {
		var err error
		if todo, err = r.file("Retry webhook deliveries", "[FILE retry.md] Retry failed webhook deliveries with retryExponential()"); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(todo, 8*time.Minute, "in_review")
		if err != nil {
			return err
		}
		if _, err = r.checkPull(v.PR.Number, v.PR.Head); err != nil {
			return err
		}
		// The review runs on the open PR; Merge waits for its verdict.
		for deadline := time.Now().Add(2 * time.Minute); v.Merge.State != "ready"; time.Sleep(500 * time.Millisecond) {
			if time.Now().After(deadline) {
				return fmt.Errorf("T%d merge %q (%s) two minutes after in_review", todo, v.Merge.State, v.Merge.Reason)
			}
			if v, err = r.todo(todo); err != nil {
				return err
			}
		}
		if err = r.merge(todo, v.PR.Head); err != nil {
			return err
		}
		if err = r.waitMerged(todo, v.PR.Number, v.PR.Head); err != nil {
			return err
		}
		pull, err := r.readFakePull(v.PR.Number)
		if err != nil {
			return err
		}
		squash = pull.MergeCommitSHA
		r.actual = fmt.Sprintf("T%d merged as PR #%d; install main = GitHub's squash %s", todo, pull.Number, squash[:12])
		return r.pool.QueryRow(r.ctx, `SELECT id::text FROM mythical_items WHERE number=$1`, todo).Scan(&item)
	})
	r.step("1 Learning admitted", "SQL product_job_requests learning.admission; SQL mythical_items; /api/live home", "one background learning admission keyed by T<n>'s merge commit; no TODO made; Home's background runs list Learning · T<n>", "T-FLW-06", func() error {
		if item == "" || squash == "" {
			return fmt.Errorf("blocked by 1 TODO merges: no merged TODO")
		}
		var request, jobState, authorization, payload, reason, lastError string
		for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(250 * time.Millisecond) {
			var count int
			if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='learning.admission' AND payload->>'todo'=$1`, fmt.Sprint(todo)).Scan(&count); err != nil {
				return err
			}
			if count == 1 {
				break
			}
			if count > 1 || time.Now().After(deadline) {
				return fmt.Errorf("T%d has %d learning admissions 30 s after its merge", todo, count)
			}
		}
		if err := r.pool.QueryRow(r.ctx, `SELECT r.request_id, r.state, r.authorization_context::text, r.payload::text,
 coalesce(d.external_receipt->>'reason',''), coalesce(d.last_error,'')
 FROM product_job_requests r LEFT JOIN product_job_dispatches d ON d.operation_id=r.id
 WHERE r.operation='learning.admission' AND r.payload->>'todo'=$1`, fmt.Sprint(todo)).Scan(&request, &jobState, &authorization, &payload, &reason, &lastError); err != nil {
			return err
		}
		var admission struct {
			Item   string `json:"item"`
			Commit string `json:"commit"`
		}
		var authority struct {
			Source string `json:"source"`
			Class  string `json:"class"`
		}
		if err := json.Unmarshal([]byte(payload), &admission); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(authorization), &authority); err != nil {
			return err
		}
		if request != "learning:"+item || admission.Item != item || admission.Commit != squash {
			return fmt.Errorf("learning admission %s for item %s at %s, want T%d's item %s at the squash %s", request, admission.Item, admission.Commit, todo, item, squash)
		}
		if authority.Class != "background" || authority.Source != "confirmed-github-merge" {
			return fmt.Errorf("learning admission authorized as %s, want a background run from the confirmed merge", authorization)
		}
		var todos int
		if err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE source='todo'`).Scan(&todos); err != nil {
			return err
		}
		if todos != 1 {
			return fmt.Errorf("the install holds %d TODOs after the merge; learning must make none", todos)
		}
		owner, err := r.openLive(r.jar)
		if err != nil {
			return err
		}
		if _, err = owner.subscribe("home"); err != nil {
			return err
		}
		title := fmt.Sprintf("Learning · T%d", todo)
		var shown string
		if _, err = owner.wait("home", 30*time.Second, func(frame liveFrame) bool {
			var home struct {
				Runs []struct {
					Title string `json:"title"`
					State string `json:"state"`
				} `json:"background_runs"`
			}
			_ = json.Unmarshal(frame.Data, &home)
			for _, run := range home.Runs {
				if run.Title == title {
					shown = run.State
				}
			}
			return shown != ""
		}); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("%s %s class=background; Home %q %s; %d TODO; checkpoint %q, last error %q", request, jobState, title, shown, todos, reason, lastError)
		return nil
	})
	r.pending("1 Learning writes the decision page", "learning run in its machine; GET /api/repos/{o}/{r}/wiki; SQL mythical_items.lessons", "one page revision linking PR and merge commit, with a reason from a steer or review, authored {agent: coding, run}; T<n> shows N lessons", "T-FLW-06", "learning-rehearsal-runtime")
	const (
		base      = "# Webhook retries\n\nDecision: webhook redelivery uses `retryExponential()`.\nReason: provider rate limits.\n"
		decision  = "Decision: webhook redelivery uses `retryExponential()`.\nReason: provider rate limits."
		changed   = "Decision: webhook redelivery uses `retryFixed(5000)`. `retryExponential()` is not used for webhooks.\nReason: the provider's idempotency window."
		note      = "\nNotes: the provider documents its retry headers.\n"
		coEdited  = "# Webhook retries\n\n" + changed + "\n" + note
		slug      = "decisions-webhook-retries"
		pagePath  = "decisions/webhook-retries.md"
		wikiRoute = "/api/repos/" + rehearsalRepository + "/wiki"
		pageRoute = wikiRoute + "/"
	)
	var ben http.CookieJar
	var page struct {
		ID       int64  `json:"id"`
		Revision int64  `json:"revision"`
		Body     string `json:"body"`
		Path     string `json:"path"`
		Author   struct {
			Login string `json:"login"`
		} `json:"author"`
	}
	var edited int64
	if !r.step("2 Co-edit live", "POST "+wikiRoute+" (stand-in for 1's page); /api/live doc:wiki:<id> as the owner and Ben", "each sees the other's edit in under 1 s; Ben's changed decision and the owner's note converge in both pages", "T-COL-09", func() error {
		var err error
		if ben, err = r.member("ben", 201, "write"); err != nil {
			return err
		}
		body, _ := json.Marshal(map[string]string{"title": "Webhook retries", "slug": slug, "path": pagePath, "body": base})
		data, err := r.expect("POST", wikiRoute, string(body), 201)
		if err != nil {
			return err
		}
		if err = json.Unmarshal(data, &page); err != nil {
			return err
		}
		owner, err := r.openWikiPage(r.jar, page.ID)
		if err != nil {
			return err
		}
		defer owner.close()
		member, err := r.openWikiPage(ben, page.ID)
		if err != nil {
			return err
		}
		defer member.close()
		// Ben's arrival sends the owner his author entry; settle it first.
		time.Sleep(300 * time.Millisecond)
		// Both edits start from the page as each opened it: concurrent.
		ownerEdit, err := r.yjsEdit(owner.state, owner.client, "", note)
		if err != nil {
			return err
		}
		benEdit, err := r.yjsEdit(member.state, member.client, decision, changed)
		if err != nil {
			return err
		}
		mark := member.mark()
		sent := time.Now()
		if err = owner.update(r.ctx, ownerEdit); err != nil {
			return err
		}
		arrived, err := member.wait(mark, 5*time.Second, wikiSync(2))
		if err != nil {
			return fmt.Errorf("Ben did not receive the owner's edit: %w", err)
		}
		toBen := arrived.at.Sub(sent)
		// The owner's own echo arrives before Ben types.
		if _, err = owner.wait(0, 5*time.Second, func(frame wikiFrame) bool { return wikiSync(2)(frame) && frame.at.After(sent) }); err != nil {
			return err
		}
		mark = owner.mark()
		sent = time.Now()
		if err = member.update(r.ctx, benEdit); err != nil {
			return err
		}
		arrived, err = owner.wait(mark, 5*time.Second, wikiSync(2))
		if err != nil {
			return fmt.Errorf("the owner did not receive Ben's edit: %w", err)
		}
		toOwner := arrived.at.Sub(sent)
		// One revision per idle period, acknowledged only after it commits.
		var revision int64
		if err = r.pool.QueryRow(r.ctx, `SELECT revision FROM wiki_pages WHERE id=$1`, page.ID).Scan(&revision); err != nil {
			return err
		}
		if revision != page.Revision {
			return fmt.Errorf("revision %d before the idle period, want %d", revision, page.Revision)
		}
		if toBen >= time.Second || toOwner >= time.Second {
			return fmt.Errorf("edits arrived in %s and %s, want under 1 s", toBen, toOwner)
		}
		for _, editor := range []*wikiEditor{owner, member} {
			saved, err := editor.wait(0, 10*time.Second, func(frame wikiFrame) bool {
				var receipt struct {
					T   string `json:"t"`
					Seq uint64 `json:"seq"`
				}
				return frame.text && json.Unmarshal(frame.raw, &receipt) == nil && receipt.T == "saved" && receipt.Seq > 0
			})
			if err != nil {
				return fmt.Errorf("no save receipt covering the edits: %w", err)
			}
			if saved.at.Before(sent) {
				return fmt.Errorf("a save receipt preceded the edits")
			}
		}
		ownerView, err := r.yjsView(owner.state, append([][]byte{ownerEdit}, owner.updates()...)...)
		if err != nil {
			return err
		}
		benView, err := r.yjsView(member.state, append([][]byte{benEdit}, member.updates()...)...)
		if err != nil {
			return err
		}
		if ownerView.Text != coEdited || benView.Text != coEdited {
			return fmt.Errorf("pages diverged: owner %q, Ben %q, want %q", ownerView.Text, benView.Text, coEdited)
		}
		if err = r.pool.QueryRow(r.ctx, `SELECT revision FROM wiki_pages WHERE id=$1`, page.ID).Scan(&edited); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("page %d rev %d; owner→Ben %s, Ben→owner %s; both pages %d bytes, equal; saved after the idle period at rev %d", page.ID, page.Revision, toBen.Round(time.Millisecond), toOwner.Round(time.Millisecond), len(coEdited), edited)
		return nil
	}) {
		return
	}
	r.step("2 One revision names both", "GET "+pageRoute+"{slug} as the owner and Ben; GET …/revisions; GET …/history/{id}/{rev}/content; SQL wiki_page_revisions", "one new revision with the changed decision, stored byte-identical for both; its authors name the owner and Ben; revision 1 unchanged", "T-COL-09", func() error {
		if edited != page.Revision+1 {
			return fmt.Errorf("the co-edit wrote revision %d over %d, want exactly one", edited, page.Revision)
		}
		for _, jar := range []http.CookieJar{r.jar, ben} {
			data, err := r.expectAs(jar, "GET", pageRoute+slug, "", 200)
			if err != nil {
				return err
			}
			var stored struct {
				Body     string `json:"body"`
				Revision int64  `json:"revision"`
			}
			if err = json.Unmarshal(data, &stored); err != nil {
				return err
			}
			if stored.Body != coEdited || stored.Revision != edited {
				return fmt.Errorf("GET rev %d body %q, want rev %d %q", stored.Revision, stored.Body, edited, coEdited)
			}
		}
		original, err := r.expect("GET", fmt.Sprintf("%shistory/%d/%d/content", pageRoute, page.ID, page.Revision), "", 200)
		if err != nil {
			return err
		}
		if string(original) != base {
			return fmt.Errorf("revision %d reads %q, want the original page", page.Revision, original)
		}
		data, err := r.expect("GET", pageRoute+slug+"/revisions", "", 200)
		if err != nil {
			return err
		}
		var revisions []struct {
			Revision int64 `json:"revision"`
		}
		if err = json.Unmarshal(data, &revisions); err != nil {
			return err
		}
		var numbers []int64
		for _, revision := range revisions {
			numbers = append(numbers, revision.Revision)
		}
		if !slices.Contains(numbers, page.Revision) || !slices.Contains(numbers, edited) {
			return fmt.Errorf("history lists %v, want %d and %d", numbers, page.Revision, edited)
		}
		var state []byte
		if err = r.pool.QueryRow(r.ctx, `SELECT crdt_state FROM wiki_page_revisions WHERE page_id=$1 AND revision=$2`, page.ID, edited).Scan(&state); err != nil {
			return err
		}
		view, err := r.yjsView(base64.StdEncoding.EncodeToString(state))
		if err != nil {
			return err
		}
		var ownerID, benID int64
		if err = r.pool.QueryRow(r.ctx, `SELECT id FROM users WHERE lower_username='rehearsal-owner'`).Scan(&ownerID); err != nil {
			return err
		}
		if err = r.pool.QueryRow(r.ctx, `SELECT id FROM users WHERE lower_username='ben'`).Scan(&benID); err != nil {
			return err
		}
		authors := map[string]bool{}
		for _, member := range view.Authors {
			authors[member] = true
		}
		if view.Text != coEdited || !authors[fmt.Sprint(ownerID)] || !authors[fmt.Sprint(benID)] {
			return fmt.Errorf("revision %d holds %q by %v, want both editors %d and %d", edited, view.Text, view.Authors, ownerID, benID)
		}
		r.actual = fmt.Sprintf("rev %d byte-identical for the owner and Ben; authors %v; history %v; rev %d reads the original", edited, view.Authors, numbers, page.Revision)
		return nil
	})
	r.pending("3 Plan cites the edited revision", "POST /api/todos (T1's prompt); GET /api/todos/{n} evidence", fmt.Sprintf("the plan receipt cites %s at the co-edited revision with its SHA-256, and no earlier revision", slug), "T-FLW-10", "plan-wiki-provider")
	r.pending("3 Plan follows the decision", "GET /api/todos/{n} plan; PR diff", "the plan and PR call retryFixed(5000) from deliver.ts and add no retryExponential( call", "T-FLW-10", "plan-wiki-provider")
	r.step("C-J8-03 Obsidian folder", "PUT /api/install {wiki_sync.obsidian}; folder sync passes; PATCH "+pageRoute+"{slug}", "a folder inside the state directory refused with folder_refused; the page exported byte-identical; a line added on disk becomes a revision by the owner; an app edit reaches the folder within one interval", "T-FLW-12", func() error {
		inside := filepath.Join(state, "vault")
		if err := os.MkdirAll(inside, 0700); err != nil {
			return err
		}
		setting := func(path string) string {
			body, _ := json.Marshal(map[string]any{"wiki_sync.obsidian": map[string]string{"path": path}})
			return string(body)
		}
		code, data, err := r.keyed("PUT", "/api/install", setting(inside), r.keyPrefix+"obsidian-inside")
		if err != nil {
			return err
		}
		if code != 400 || !strings.Contains(string(data), `"folder_refused"`) {
			return fmt.Errorf("a folder in the state directory answered %d %s, want 400 folder_refused", code, data)
		}
		vault := r.t.TempDir()
		if _, err = r.expect("PUT", "/api/install", setting(vault), 200); err != nil {
			return err
		}
		read := func() (int64, string, string, error) {
			data, err := r.expect("GET", pageRoute+slug, "", 200)
			if err != nil {
				return 0, "", "", err
			}
			if err = json.Unmarshal(data, &page); err != nil {
				return 0, "", "", err
			}
			return page.Revision, page.Body, page.Author.Login, nil
		}
		revision, body, _, err := read()
		if err != nil {
			return err
		}
		// The sync's pass runs once a minute (wiki_sync.interval_seconds).
		const interval = 75 * time.Second
		file := filepath.Join(vault, filepath.FromSlash(page.Path))
		exported := ""
		for deadline := time.Now().Add(2 * interval); ; time.Sleep(time.Second) {
			raw, err := os.ReadFile(file)
			if err == nil && string(raw) == body {
				exported = string(raw)
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("%s holds %q (%v) two intervals after the setting, want rev %d's body", page.Path, raw, err, revision)
			}
		}
		const line = "Alice: confirmed with the provider on the call.\n"
		if err = os.WriteFile(file, []byte(exported+line), 0600); err != nil {
			return err
		}
		var imported int64
		var author string
		for deadline := time.Now().Add(2 * interval); ; time.Sleep(time.Second) {
			current, text, login, err := read()
			if err != nil {
				return err
			}
			if current > revision && text == exported+line {
				imported, author = current, login
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("the page is rev %d %q two intervals after the disk edit", current, text)
			}
		}
		if author != "rehearsal-owner" {
			return fmt.Errorf("the imported rev %d is by %q, want the owner", imported, author)
		}
		appEdit := exported + line + "Owner: approved for the next release.\n"
		patch, _ := json.Marshal(map[string]any{"body": appEdit, "expected_revision": imported})
		if _, err = r.expect("PATCH", pageRoute+slug, string(patch), 200); err != nil {
			return err
		}
		for deadline := time.Now().Add(2 * interval); ; time.Sleep(time.Second) {
			raw, err := os.ReadFile(file)
			if err == nil && string(raw) == appEdit {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("%s holds %q two intervals after the app edit", page.Path, raw)
			}
		}
		r.actual = fmt.Sprintf("inside the state dir: 400 folder_refused; %s exported at rev %d; disk line → rev %d by %s; app edit → folder", page.Path, revision, imported, author)
		return nil
	})
}

// wikiFrame is one frame the install sent a wiki editor, and when it came.
type wikiFrame struct {
	raw  []byte
	text bool
	at   time.Time
}

// wikiEditor is a browser's /api/live subscription to one wiki page's
// document (doc:wiki:<id>), speaking the shared document frames: a JSON
// snapshot names its client, binary [1][id][sync] frames carry Yjs sync
// steps and updates, and JSON saved frames acknowledge committed revisions.
type wikiEditor struct {
	conn    *websocket.Conn
	mu      sync.Mutex
	frames  []wikiFrame
	arrived chan struct{}
	err     error
	client  uint32
	// state is the page's Yjs state when the editor opened it, base64.
	state string
}

// openWikiPage subscribes the browser that holds jar to page's live document
// from the install's own page, completes Yjs sync step 1, and waits for the
// first save receipt.
func (r *rehearsal) openWikiPage(jar http.CookieJar, page int64) (*wikiEditor, error) {
	origin, err := url.Parse(r.origin)
	if err != nil {
		return nil, err
	}
	var cookies []string
	for _, cookie := range jar.Cookies(origin) {
		cookies = append(cookies, cookie.Name+"="+cookie.Value)
	}
	conn, _, err := websocket.Dial(r.ctx, "ws"+strings.TrimPrefix(r.origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol},
		HTTPHeader: http.Header{"Origin": {r.origin}, "Cookie": {strings.Join(cookies, "; ")}}})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(16 << 20)
	e := &wikiEditor{conn: conn, arrived: make(chan struct{}, 1)}
	go func() {
		for {
			kind, raw, err := conn.Read(r.ctx)
			e.mu.Lock()
			if err != nil {
				e.err = err
			} else {
				e.frames = append(e.frames, wikiFrame{raw: raw, text: kind == websocket.MessageText, at: time.Now()})
			}
			e.mu.Unlock()
			select {
			case e.arrived <- struct{}{}:
			default:
			}
			if err != nil {
				return
			}
		}
	}()
	fail := func(err error) (*wikiEditor, error) {
		e.close()
		return nil, err
	}
	if err = conn.Write(r.ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":"doc:wiki:%d"}`, page))); err != nil {
		return fail(err)
	}
	snap, err := e.wait(0, 15*time.Second, func(frame wikiFrame) bool { return frame.text && strings.Contains(string(frame.raw), `"t":"snap"`) })
	if err != nil {
		return fail(err)
	}
	var opened struct {
		Data struct {
			ClientID uint32 `json:"client_id"`
		} `json:"data"`
	}
	if err = json.Unmarshal(snap.raw, &opened); err != nil || opened.Data.ClientID == 0 {
		return fail(fmt.Errorf("doc:wiki:%d snapshot names no client: %s", page, snap.raw))
	}
	e.client = opened.Data.ClientID
	// Yjs sync step 1 with an empty state vector; the reply is step 2.
	mark := e.mark()
	if err = conn.Write(r.ctx, websocket.MessageBinary, []byte{1, 0, 0, 0, 1, 0, 1, 0}); err != nil {
		return fail(err)
	}
	reply, err := e.wait(mark, 15*time.Second, wikiSync(1))
	if err != nil {
		return fail(err)
	}
	_, data, _ := wikiSyncData(reply)
	e.state = base64.StdEncoding.EncodeToString(data)
	if _, err = e.wait(mark, 15*time.Second, func(frame wikiFrame) bool { return frame.text && strings.Contains(string(frame.raw), `"t":"saved"`) }); err != nil {
		return fail(err)
	}
	return e, nil
}

// update sends one Yjs update as this editor's keystrokes.
func (e *wikiEditor) update(ctx context.Context, update []byte) error {
	frame := []byte{1, 0, 0, 0, 1, 2}
	frame = binary.AppendUvarint(frame, uint64(len(update)))
	return e.conn.Write(ctx, websocket.MessageBinary, append(frame, update...))
}

// mark is the number of frames received so far.
func (e *wikiEditor) mark() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.frames)
}

// updates are the Yjs updates the install broadcast to this editor.
func (e *wikiEditor) updates() [][]byte {
	e.mu.Lock()
	defer e.mu.Unlock()
	var updates [][]byte
	for _, frame := range e.frames {
		if kind, data, ok := wikiSyncData(frame); ok && kind == 2 {
			updates = append(updates, data)
		}
	}
	return updates
}

// wait answers the first frame from index from on that satisfies ok; a
// refusal of the subscription fails at once.
func (e *wikiEditor) wait(from int, within time.Duration, ok func(wikiFrame) bool) (wikiFrame, error) {
	deadline := time.After(within)
	for {
		e.mu.Lock()
		frames, closed := e.frames[min(from, len(e.frames)):], e.err
		e.mu.Unlock()
		for _, frame := range frames {
			if frame.text && strings.Contains(string(frame.raw), `"t":"err"`) {
				return frame, fmt.Errorf("doc:wiki refused: %s", frame.raw)
			}
			if ok(frame) {
				return frame, nil
			}
		}
		if closed != nil {
			return wikiFrame{}, fmt.Errorf("/api/live closed: %w", closed)
		}
		select {
		case <-e.arrived:
		case <-time.After(100 * time.Millisecond):
		case <-deadline:
			return wikiFrame{}, fmt.Errorf("no wanted frame within %s", within)
		}
	}
}

func (e *wikiEditor) close() { _ = e.conn.CloseNow() }

// wikiSync matches a binary sync frame of kind: 1 a sync step 2 reply, 2 an
// update.
func wikiSync(kind uint64) func(wikiFrame) bool {
	return func(frame wikiFrame) bool {
		got, _, ok := wikiSyncData(frame)
		return ok && got == kind
	}
}

// wikiSyncData decodes a binary [1][subscription][kind][length][data] frame.
func wikiSyncData(frame wikiFrame) (uint64, []byte, bool) {
	if frame.text || len(frame.raw) < 6 || frame.raw[0] != 1 {
		return 0, nil, false
	}
	payload := frame.raw[5:]
	kind, n := binary.Uvarint(payload)
	if n <= 0 {
		return 0, nil, false
	}
	size, m := binary.Uvarint(payload[n:])
	if m <= 0 || size != uint64(len(payload)-n-m) {
		return 0, nil, false
	}
	return kind, payload[n+m:], true
}

// yjsEdit is one editor's keystrokes as the app's Yjs makes them: from state,
// as client, find is replaced with replacement (appended when find is empty).
func (r *rehearsal) yjsEdit(state string, client uint32, find, replacement string) ([]byte, error) {
	out, err := r.yjs(`const [state,id,find,replacement]=Bun.argv.slice(1);const d=new Y.Doc();Y.applyUpdate(d,Buffer.from(state,'base64'));d.clientID=Number(id);const sv=Y.encodeStateVector(d);const y=d.getText('markdown');const text=y.toString();const at=find===''?text.length:text.indexOf(find);if(at<0)throw new Error('the page lacks the text to edit');d.transact(()=>{if(find)y.delete(at,find.length);y.insert(at,replacement)});console.log(Buffer.from(Y.encodeStateAsUpdate(d,sv)).toString('base64'));d.destroy();`,
		state, fmt.Sprint(client), find, replacement)
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(out))
}

// yjsPage is a page's text and the authors its document records.
type yjsPage struct {
	Text    string            `json:"text"`
	Authors map[string]string `json:"authors"`
}

// yjsView renders state with updates applied, as an editor's page shows it.
func (r *rehearsal) yjsView(state string, updates ...[]byte) (yjsPage, error) {
	args := []string{state}
	for _, update := range updates {
		args = append(args, base64.StdEncoding.EncodeToString(update))
	}
	out, err := r.yjs(`const d=new Y.Doc();for(const u of Bun.argv.slice(1))if(u)Y.applyUpdate(d,Buffer.from(u,'base64'));console.log(JSON.stringify({text:d.getText('markdown').toString(),authors:d.getMap('authors').toJSON()}));d.destroy();`, args...)
	if err != nil {
		return yjsPage{}, err
	}
	var page yjsPage
	return page, json.Unmarshal([]byte(out), &page)
}

// yjs runs script under bun with the app's own yjs bound to Y.
func (r *rehearsal) yjs(script string, args ...string) (string, error) {
	module := filepath.Join(r.root, "apps/app/node_modules/yjs/dist/yjs.mjs")
	out, err := exec.CommandContext(r.ctx, "bun", append([]string{"-e", fmt.Sprintf("import * as Y from %q;", module) + script}, args...)...).Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("yjs: %v: %s", err, exit.Stderr)
		}
		return "", err
	}
	return string(out), nil
}
