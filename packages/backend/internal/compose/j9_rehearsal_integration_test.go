package compose

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
)

// The J9 canary: main holds the retry helper and its caller, and the wiki
// holds the page that names it (C-J9-01 setup).
const (
	j9Retry = "import type { Delivery } from \"./types\"\n\n" +
		"export async function redeliver(delivery: Delivery, attempt = 1): Promise<void> {\n" +
		"  if (attempt > 5) throw new Error(\"webhook delivery failed\")\n" +
		"  await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 100))\n" +
		"  return delivery.send().catch(() => redeliver(delivery, attempt + 1))\n" +
		"}\n"
	j9Deliver = "import { redeliver } from \"./retry\"\nimport type { Delivery } from \"./types\"\n\n" +
		"export const deliver = (delivery: Delivery) => delivery.send().catch(() => redeliver(delivery))\n"
	j9Webhooks = "# Webhooks\n\nFailed deliveries retry through `redeliver()` in src/webhooks/retry.ts, at most 5 attempts.\n"
)

// j9Card is what the J9 rows read of a card frame: a File card's path,
// cited line, bytes and the commit it was read at.
type j9Card struct {
	Type string `json:"type"`
	Card struct {
		Kind    string `json:"kind"`
		Payload struct {
			Path    string `json:"path"`
			Line    int64  `json:"line"`
			Content string `json:"content"`
			ReadAt  struct {
				CommitID string `json:"commitId"`
			} `json:"readAt"`
		} `json:"payload"`
	} `json:"card"`
}

// j9Item is one context item of an entry's preflight.
type j9Item struct {
	Kind     string `json:"kind"`
	Label    string `json:"label"`
	Ref      string `json:"ref"`
	Revision string `json:"revision"`
}

// j9Todo is what the commit rows read of GET /api/todos/{n}.
type j9Todo struct {
	N         int64  `json:"n"`
	Title     string `json:"title"`
	State     string `json:"state"`
	Revisions []struct {
		Text string `json:"text"`
		By   struct {
			Login string `json:"login"`
		} `json:"by"`
	} `json:"prompt_revisions"`
}

// askAs asks main's conversation as the member whose browser holds jar,
// through the same prompt route and poll as the owner's ask, and answers the
// turn's shared entry as that member reads it. Nothing else uses r.jar while
// a J9 row asks.
func (r *rehearsal) askAs(jar http.CookieJar, question string) (string, chat.SharedTurn, error) {
	owner := r.jar
	r.jar = jar
	answer, _, terminal, err := r.ask("", question)
	r.jar = owner
	if err != nil {
		return answer, chat.SharedTurn{}, err
	}
	if !terminal {
		return answer, chat.SharedTurn{}, fmt.Errorf("the turn did not finish")
	}
	entry, err := r.j9Entry(jar, question)
	return answer, entry, err
}

// j9Entry is the newest shared entry of main's conversation whose prompt is
// prompt, as the member whose browser holds jar reads it.
func (r *rehearsal) j9Entry(jar http.CookieJar, prompt string) (chat.SharedTurn, error) {
	data, err := r.expectAs(jar, "GET", "/api/conversations/main", "", 200)
	if err != nil {
		return chat.SharedTurn{}, err
	}
	var conversation chat.SharedConversation
	if err = json.Unmarshal(data, &conversation); err != nil {
		return chat.SharedTurn{}, err
	}
	for i := len(conversation.Entries) - 1; i >= 0; i-- {
		if conversation.Entries[i].Prompt == prompt {
			return conversation.Entries[i], nil
		}
	}
	return chat.SharedTurn{}, fmt.Errorf("main's conversation holds no entry for %q (%d entries)", prompt, len(conversation.Entries))
}

// j9FileCard is the entry's File card for path.
func j9FileCard(entry chat.SharedTurn, path string) (j9Card, bool) {
	for _, raw := range entry.Frames {
		var frame j9Card
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "card" && frame.Card.Kind == "file" && frame.Card.Payload.Path == path {
			return frame, true
		}
	}
	return j9Card{}, false
}

// j9Commit commits a Draft as the browser that holds jar presses Commit
// twice: two POST /api/todos with one Idempotency-Key. It answers the TODO.
func (r *rehearsal) j9Commit(jar http.CookieJar, title, prompt, key string) (int64, error) {
	body, _ := json.Marshal(map[string]any{"title": title, "prompt": prompt, "place": map[string]string{"mode": "append"}})
	var number int64
	for press := range 2 {
		code, data, err := r.keyedAs(jar, "POST", "/api/todos", string(body), key)
		if err != nil {
			return 0, err
		}
		var receipt struct {
			N     int64  `json:"n"`
			State string `json:"state"`
		}
		if code != 202 || json.Unmarshal(data, &receipt) != nil || receipt.N <= 0 || receipt.State != "accepted" || number != 0 && receipt.N != number {
			return 0, fmt.Errorf("Commit press %d after T%d: %s", press+1, number, r.actual)
		}
		number = receipt.N
	}
	return number, nil
}

// j9Placed checks TODO n is Queued, last on the stack, with revision 1
// prompt by login, and that the stack grew by one.
func (r *rehearsal) j9Placed(jar http.CookieJar, number int64, before int, title, prompt, login string) (j9Todo, error) {
	list, err := r.todoList()
	if err != nil {
		return j9Todo{}, err
	}
	if len(list) != before+1 || list[len(list)-1].N != number {
		return j9Todo{}, fmt.Errorf("the stack has %d TODOs (want %d) and ends with %v, not T%d", len(list), before+1, list[len(list)-1].N, number)
	}
	var todo j9Todo
	data, err := r.expectAs(jar, "GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	if err == nil {
		err = json.Unmarshal(data, &todo)
	}
	if err != nil {
		return todo, err
	}
	if todo.Title != title || todo.State != "queued" || len(todo.Revisions) != 1 || todo.Revisions[0].Text != prompt || todo.Revisions[0].By.Login != login {
		return todo, fmt.Errorf("T%d is %q %s with %d revisions, want %q queued with revision 1 the committed prompt by %s", number, todo.Title, todo.State, len(todo.Revisions), title, login)
	}
	return todo, nil
}

// j9Save saves an answer as a page, as Save to wiki and /wiki.save do
// (cloud-wiki.ts sendWikiSave): POST the repository's wiki with the
// request's own slug. It answers the page's author and revision count.
func (r *rehearsal) j9Save(jar http.CookieJar, name, text string) (string, int, error) {
	slug := "answer-" + uuid.NewString()
	body, _ := json.Marshal(map[string]string{"title": name, "body": text, "slug": slug, "path": name + ".md"})
	if _, err := r.expectAs(jar, "POST", "/api/repos/rehearsal-owner/app/wiki?visibility=public", string(body), 201); err != nil {
		return "", 0, err
	}
	var author, stored string
	var pages, revisions int
	if err := r.pool.QueryRow(r.ctx, `SELECT count(*) OVER (), u.username, p.body, (SELECT count(*) FROM wiki_page_revisions v WHERE v.page_id=p.id)
	  FROM wiki_pages p JOIN users u ON u.id=p.author_id WHERE p.title=$1`, name).Scan(&pages, &author, &stored, &revisions); err != nil {
		return "", 0, err
	}
	if pages != 1 || stored != text {
		return author, revisions, fmt.Errorf("%d pages titled %q; body is the answer: %t", pages, name, stored == text)
	}
	return author, revisions, nil
}

// j9Instruction is one UI-only flow a turn asked its author's screen to run.
type j9Instruction struct {
	ID      string            `json:"id"`
	Command string            `json:"command"`
	Payload map[string]string `json:"payload"`
}

// j9Instructions are the UI instructions main's view state serves the
// member whose browser holds jar.
func (r *rehearsal) j9Instructions(jar http.CookieJar) ([]j9Instruction, error) {
	var view struct {
		Instructions []j9Instruction `json:"instructions"`
	}
	data, err := r.expectAs(jar, "GET", "/api/conversations/main/view-state", "", 200)
	if err == nil {
		err = json.Unmarshal(data, &view)
	}
	return view.Instructions, err
}

// j9Confirmation names the pending confirmation a confirm command answered.
var j9Confirmation = regexp.MustCompile(`"confirmation":"([^"]+)","state":"pending"`)

// TestJ9Rehearsal walks journey J9 (mvp.md §5, ask the repository; C-J9-01)
// on an install set up through Source ready. A question needs no machine, and
// a TODO committed before Machine ready stays Queued, so the rehearsal sets up
// none and runs no coding agent. main gains src/webhooks/retry.ts with
// redeliver() and its caller, and the wiki the page "Webhooks". Members Ben
// and Alice sign in; Ben asks in main's conversation, Alice reads it.
//
// The app agent's model is the scripted chat fixture (localChatProvider):
// each "Run /" line of a prompt is the command a model would choose, and the
// answer quotes what the commands returned. Its preflight selector answers
// an empty choice, so the rows check the candidates preflight offered, not
// a selection. The Make TODO and Save to wiki buttons, and the Draft card
// they open, are browser-rendered (AnswerActions.ts); their rows commit and
// save through the same routes the card files call, and the buttons
// themselves wait on the browser check (ask-repository.spec.ts).
func TestJ9Rehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J9_REHEARSAL", "C-J9", "j9-")
	r.quiet = true
	ready := r.setupSource()
	r.quiet = false
	if !r.step("0 Install through Source ready", "J1 setup rows: setup URL token … 6 source ready", "every J1 setup row through Source ready passes; stack active", "T-INS-06", func() error {
		if len(r.quietFailed) > 0 {
			return errors.New(strings.Join(r.quietFailed, "; "))
		}
		return r.waitStackActive()
	}) || !ready {
		return
	}
	var ben, alice http.CookieJar
	canary := ""
	if !r.step("0 Canary main, the Webhooks page, Ben and Alice", "GitHub fake push to main; POST /api/github/sync; POST /api/repos/{o}/{r}/wiki; POST /api/members", "the install's main follows the canary commit; the Webhooks page at revision 1; Ben and Alice signed in", "T-GH-02, T-COL-09, T-ACC-02", func() error {
		var err error
		if canary, err = r.pushGitHubMain("Webhook retries", map[string]string{"src/webhooks/retry.ts": j9Retry, "src/webhooks/deliver.ts": j9Deliver}); err != nil {
			return err
		}
		body, _ := json.Marshal(map[string]string{"title": "Webhooks", "body": j9Webhooks, "slug": "webhooks", "path": "Webhooks.md"})
		if _, err = r.expect("POST", "/api/repos/rehearsal-owner/app/wiki?visibility=public", string(body), 201); err != nil {
			return err
		}
		if ben, err = r.member("ben", 901, "write"); err != nil {
			return fmt.Errorf("ben: %w", err)
		}
		if alice, err = r.member("alice", 902, "write"); err != nil {
			return fmt.Errorf("alice: %w", err)
		}
		r.actual = fmt.Sprintf("main %s; Webhooks page; ben and alice signed in", canary)
		return nil
	}) {
		return
	}
	const (
		question = "where do we retry webhooks?\nRun /file src/webhooks/retry.ts:3\nRun /wiki.open Webhooks.md"
		second   = "what calls redeliver?\nRun /file src/webhooks/deliver.ts"
	)
	var first chat.SharedTurn
	answer := ""
	if !r.step("1 Ben asks where we retry webhooks", "POST /api/conversations/main/prompt as Ben; GET /api/conversations/main as Alice", "the turn finishes; Alice reads Ben's entry and its answer; no machine starts and no TODO is filed", "T-APP-16", func() error {
		creates := len(r.compute.Creates())
		todos, err := r.todoList()
		if err != nil {
			return err
		}
		if answer, _, err = r.askAs(ben, question); err != nil {
			return err
		}
		if first, err = r.j9Entry(alice, question); err != nil {
			return err
		}
		after, err := r.todoList()
		if err != nil {
			return err
		}
		r.actual = fmt.Sprintf("entry %s by %s %s; answer %.120q", first.ID, first.AuthorLogin, first.State, answer)
		if first.AuthorLogin != "ben" || first.State != chat.StateCompleted || strings.TrimSpace(answer) == "" {
			return fmt.Errorf("Alice does not read Ben's completed answer")
		}
		if len(r.compute.Creates()) != creates || len(after) != len(todos) {
			return fmt.Errorf("the question started %d machines and filed %d TODOs", len(r.compute.Creates())-creates, len(after)-len(todos))
		}
		return nil
	}) {
		return
	}
	r.step("2 Preflight offers retry.ts and the Webhooks page", "the entry's preflight (GET /api/conversations/main)", "candidates include src/webhooks/retry.ts and the Webhooks page at revision 1; the selection ran on the fast model", "T-APP-17", func() error {
		if first.Preflight == nil {
			return fmt.Errorf("the answer entry has no preflight")
		}
		var file, page bool
		for _, raw := range first.Preflight.Candidates {
			var item j9Item
			if json.Unmarshal(raw, &item) != nil {
				continue
			}
			file = file || item.Kind == "file" && item.Ref == "src/webhooks/retry.ts"
			page = page || item.Kind == "page" && item.Label == "Webhooks" && item.Revision == "1"
		}
		r.actual = fmt.Sprintf("%d candidates (retry.ts %t, Webhooks %t); %d selected by %s in %.0fms", len(first.Preflight.Candidates), file, page, len(first.Preflight.Context), first.Preflight.Model, first.Preflight.DurationMs)
		if !file || !page || first.Preflight.Model != "test-model" {
			return fmt.Errorf("preflight did not offer retry.ts and the Webhooks page on the fast model")
		}
		return nil
	})
	r.step("2 File card cites redeliver in retry.ts", "the answer's File card (GET /api/conversations/main as Alice)", "a File card for src/webhooks/retry.ts at the canary commit, cited at line 3, whose line holds redeliver; the answer names retry.ts", "T-APP-15, T-APP-16", func() error {
		card, ok := j9FileCard(first, "src/webhooks/retry.ts")
		if !ok {
			return fmt.Errorf("the answer has no File card for src/webhooks/retry.ts")
		}
		lines := strings.Split(card.Card.Payload.Content, "\n")
		cited := ""
		if line := card.Card.Payload.Line; line >= 1 && int(line) <= len(lines) {
			cited = lines[line-1]
		}
		r.actual = fmt.Sprintf("File card %s:%d at %s: %q", card.Card.Payload.Path, card.Card.Payload.Line, card.Card.Payload.ReadAt.CommitID, cited)
		if card.Card.Payload.Content != j9Retry || card.Card.Payload.ReadAt.CommitID != canary || !strings.Contains(cited, "redeliver") || !strings.Contains(answer, "retry.ts") {
			return fmt.Errorf("the File card is not main's retry.ts cited at redeliver")
		}
		return nil
	})
	r.step("2 Wiki card for Webhooks on Ben's screen", "GET /api/conversations/main/view-state as Ben, then Alice", "Ben's view holds the turn's wiki.open of Webhooks.md, which embeds the wiki card; Alice's holds none", "T-APP-16, T-COL-09", func() error {
		mine, err := r.j9Instructions(ben)
		if err != nil {
			return err
		}
		theirs, err := r.j9Instructions(alice)
		if err != nil {
			return err
		}
		opened := slices.ContainsFunc(mine, func(instruction j9Instruction) bool {
			return strings.HasPrefix(instruction.ID, first.ID+":") && instruction.Command == "wiki.open" && instruction.Payload["path"] == "Webhooks.md"
		})
		r.actual = fmt.Sprintf("Ben's view: %d instructions, wiki.open Webhooks.md %t; Alice's view: %d", len(mine), opened, len(theirs))
		if !opened || len(theirs) != 0 {
			return fmt.Errorf("the wiki card does not open on Ben's screen alone")
		}
		return nil
	})
	r.step("3 The answer shows Make TODO and Save to wiki", "Chromium on the composed install as Ben and Alice", "answer actions; prefilled Draft private to Ben; no TODO before Commit", "T-APP-02", func() error {
		before, err := r.todoList()
		if err != nil {
			return err
		}
		wire := func(jar http.CookieJar) string {
			var cookies []map[string]string
			for _, cookie := range jar.Cookies(mustRehearsalURL(r.origin)) {
				cookies = append(cookies, map[string]string{"name": cookie.Name, "value": cookie.Value})
			}
			raw, _ := json.Marshal(cookies)
			return string(raw)
		}
		cmd := exec.CommandContext(r.ctx, "bun", "e2e/real/ask-repository.browser.ts")
		cmd.Dir = filepath.Join(r.root, "apps/app")
		cmd.Env = append(os.Environ(), "SMITHERS_J9_BROWSER_ORIGIN="+r.origin, "SMITHERS_J9_BEN_COOKIES="+wire(ben), "SMITHERS_J9_ALICE_COOKIES="+wire(alice), "SMITHERS_J9_ANSWER="+answer, "SMITHERS_J9_BROWSER_EVIDENCE="+r.evidence)
		output, err := cmd.CombinedOutput()
		if writeErr := os.WriteFile(filepath.Join(r.evidence, "answer-browser.log"), output, 0600); writeErr != nil {
			return writeErr
		}
		if err != nil {
			return fmt.Errorf("answer browser: %w: %s", err, output)
		}
		after, err := r.todoList()
		if err != nil {
			return err
		}
		if len(after) != len(before) {
			return fmt.Errorf("opening Draft filed a TODO")
		}
		r.actual = strings.TrimSpace(string(output))
		return nil
	})
	var aliceLive *liveSocket
	defer func() {
		if aliceLive != nil {
			aliceLive.stop()
		}
	}()
	var made int64
	r.step("3 Make TODO commits once", "POST /api/todos as Ben ×2 with one Idempotency-Key; GET /api/todos; Alice's /api/live home", "one TODO, last on the stack, Queued, titled as edited, revision 1 the answer by Ben; Alice's Home shows it without a reload", "T-APP-02, T-STK-02, T-APP-01", func() error {
		before, err := r.todoList()
		if err != nil {
			return err
		}
		if aliceLive, err = r.openLive(alice); err != nil {
			return err
		}
		if _, err = aliceLive.subscribe("home"); err != nil {
			return err
		}
		if made, err = r.j9Commit(ben, "Document webhook retries", answer, r.keyPrefix+"commit-first"); err != nil {
			return err
		}
		todo, err := r.j9Placed(ben, made, len(before), "Document webhook retries", answer, "ben")
		if err != nil {
			return err
		}
		frame, err := aliceLive.wait("home", 10*time.Second, func(frame liveFrame) bool {
			return slices.ContainsFunc(decodeHome(frame).Items, func(item liveHomeItem) bool { return item.N == made })
		})
		if err != nil {
			return fmt.Errorf("Alice's Home: %w", err)
		}
		r.actual = fmt.Sprintf("T%d %q %s, last of %d; revision 1 by %s; Alice's Home cursor %d lists it", made, todo.Title, todo.State, len(before)+1, todo.Revisions[0].By.Login, *frame.Cursor)
		return nil
	})
	r.step("3 Save to wiki", "POST /api/repos/{o}/{r}/wiki as Ben (Save to wiki's request)", "201; one page whose Markdown is the answer, with one revision, authored by Ben; no Confirm", "T-APP-02, T-COL-09", func() error {
		author, revisions, err := r.j9Save(ben, "Webhook retries answer", answer)
		if err != nil {
			return err
		}
		var confirms int
		if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals WHERE command LIKE 'wiki%'`).Scan(&confirms); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("page by %s with %d revisions; %d wiki confirmations", author, revisions, confirms)
		if author != "ben" || revisions != 1 || confirms != 0 {
			return fmt.Errorf("the saved page is not Ben's one revision without a Confirm")
		}
		return nil
	})
	secondAnswer := ""
	var secondEntry chat.SharedTurn
	if !r.step("4 Ben asks what calls redeliver", "POST /api/conversations/main/prompt as Ben", "a File card for src/webhooks/deliver.ts whose text calls redeliver", "T-APP-16, T-APP-15", func() error {
		var err error
		if secondAnswer, secondEntry, err = r.askAs(ben, second); err != nil {
			return err
		}
		card, ok := j9FileCard(secondEntry, "src/webhooks/deliver.ts")
		r.actual = fmt.Sprintf("File card %t; answer %.120q", ok, secondAnswer)
		if !ok || !strings.Contains(card.Card.Payload.Content, "redeliver(") || secondAnswer == answer {
			return fmt.Errorf("the second answer has no File card for deliver.ts")
		}
		return nil
	}) {
		return
	}
	r.step("4 \"make that a TODO\" through the app agent", "POST /api/conversations/main/prompt as Ben (todo.new); GET /api/confirmations as Alice; POST /api/confirmations/{id}/approve as Ben", "a pending Confirm for Ben alone and no TODO until he approves; then one TODO, last, Queued, revision 1 the second answer by Ben; Alice's Home shows it", "T-APP-02, T-APP-16, T-ACC-03", func() error {
		if aliceLive == nil {
			return fmt.Errorf("blocked by Make TODO commits once: Alice has no live Home")
		}
		before, err := r.todoList()
		if err != nil {
			return err
		}
		args, _ := json.Marshal(map[string]string{"title": "Document redeliver callers", "text": secondAnswer})
		reply, _, err := r.askAs(ben, "make that a TODO\nRun /todo.new "+string(args))
		if err != nil {
			return err
		}
		pending := j9Confirmation.FindStringSubmatch(reply)
		if pending == nil {
			return fmt.Errorf("todo.new answered no pending confirmation: %q", reply)
		}
		if asked, err := r.todoList(); err != nil || len(asked) != len(before) {
			return fmt.Errorf("the agent's todo.new filed a TODO before Ben approved: %d → %d (%v)", len(before), len(asked), err)
		}
		for _, viewer := range []struct {
			name string
			jar  http.CookieJar
			sees bool
		}{{"Ben", ben, true}, {"Alice", alice, false}} {
			listed, err := r.expectAs(viewer.jar, "GET", "/api/confirmations", "", 200)
			if err != nil {
				return err
			}
			if strings.Contains(string(listed), pending[1]) != viewer.sees {
				return fmt.Errorf("%s's confirmations list Ben's Confirm: %t, want %t", viewer.name, !viewer.sees, viewer.sees)
			}
		}
		if _, err = r.expectAs(ben, "POST", "/api/confirmations/"+pending[1]+"/approve", "{}", 200); err != nil {
			return err
		}
		after, err := r.todoList()
		if err != nil {
			return err
		}
		if len(after) != len(before)+1 {
			return fmt.Errorf("approval made %d TODOs", len(after)-len(before))
		}
		number := after[len(after)-1].N
		todo, err := r.j9Placed(ben, number, len(before), "Document redeliver callers", secondAnswer, "ben")
		if err != nil {
			return err
		}
		if _, err = aliceLive.wait("home", 10*time.Second, func(frame liveFrame) bool {
			return slices.ContainsFunc(decodeHome(frame).Items, func(item liveHomeItem) bool { return item.N == number })
		}); err != nil {
			return fmt.Errorf("Alice's Home: %w", err)
		}
		r.actual = fmt.Sprintf("Confirm %s pending for Ben only; approved → T%d %q %s, revision 1 by %s; on Alice's Home", pending[1], number, todo.Title, todo.State, todo.Revisions[0].By.Login)
		return nil
	})
	r.step("4 /wiki.save for the second answer", "POST /api/repos/{o}/{r}/wiki as Ben (/wiki.save's request)", "201; one page whose Markdown is the second answer, one revision by Ben", "T-APP-02, T-COL-09", func() error {
		author, revisions, err := r.j9Save(ben, "Redeliver callers answer", secondAnswer)
		r.actual = fmt.Sprintf("page by %s with %d revisions", author, revisions)
		if err == nil && (author != "ben" || revisions != 1) {
			err = fmt.Errorf("the saved page is not Ben's one revision")
		}
		return err
	})
	r.step("5 Records", "SQL mythical_items, wiki_pages, wiki_page_revisions", "two TODOs with one revision each; three pages (Webhooks and two answers), one revision each; kept as evidence", "T-APP-02", func() error {
		var records string
		if err := r.pool.QueryRow(r.ctx, `SELECT json_build_object(
		  'mythical_items', (SELECT coalesce(json_agg(json_build_object('number',number,'state',state,'revisions',revisions) ORDER BY number),'[]') FROM mythical_items WHERE source='todo'),
		  'wiki_pages', (SELECT coalesce(json_agg(json_build_object('id',p.id,'title',p.title,'author',u.username) ORDER BY p.id),'[]') FROM wiki_pages p JOIN users u ON u.id=p.author_id WHERE p.title IN ('Webhooks','Webhook retries answer','Redeliver callers answer')),
		  'wiki_page_revisions', (SELECT coalesce(json_agg(json_build_object('page_id',page_id,'revision',revision) ORDER BY id),'[]') FROM wiki_page_revisions WHERE page_id IN (SELECT id FROM wiki_pages WHERE title IN ('Webhooks','Webhook retries answer','Redeliver callers answer'))))::text`).Scan(&records); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(r.evidence, "records.json"), []byte(records), 0600); err != nil {
			return err
		}
		var v struct {
			Items     []json.RawMessage `json:"mythical_items"`
			Pages     []json.RawMessage `json:"wiki_pages"`
			Revisions []json.RawMessage `json:"wiki_page_revisions"`
		}
		if err := json.Unmarshal([]byte(records), &v); err != nil {
			return err
		}
		r.actual = fmt.Sprintf("%d TODOs, %d pages, %d page revisions", len(v.Items), len(v.Pages), len(v.Revisions))
		if len(v.Items) != 2 || len(v.Pages) != 3 || len(v.Revisions) != 3 {
			return fmt.Errorf("the run's records are not 2 TODOs and 3 pages with one revision each")
		}
		return nil
	})
}
