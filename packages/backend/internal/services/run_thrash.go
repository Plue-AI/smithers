package services

import (
	"encoding/json"
	"path"
	"regexp"
	"slices"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The detector is information only. Its state belongs to one TODO attempt;
// cursors fence replay independently for each bound engine run.
type runThrash struct {
	Attempt  int32                              `json:"attempt"`
	Cursors  map[string]flowruntime.EventCursor `json:"cursors"`
	Failures []runCheckFailure                  `json:"failures"`
}
type runCheckFailure struct {
	Key   string   `json:"key"`
	Check string   `json:"check"`
	Files []string `json:"files"`
	Count int      `json:"count"`
}

var failurePath = regexp.MustCompile(`(?:[A-Za-z]:)?(?:[./\\\w-]+/)?[\w.-]+\.[A-Za-z][A-Za-z0-9]*(?::\d+(?::\d+)?)?`)
var failureNumber = regexp.MustCompile(`\d+`)
var failureLocation = regexp.MustCompile(`(?::\d+){1,2}$`)

func failureSignature(message string) string {
	return strings.Join(strings.Fields(failureNumber.ReplaceAllString(failurePath.ReplaceAllString(message, "<path>"), "#")), " ")
}
func failureFiles(message string) []string {
	files := []string{}
	for _, name := range failurePath.FindAllString(message, -1) {
		name = failureLocation.ReplaceAllString(name, "")
		name = path.Clean(strings.ReplaceAll(name, "\\", "/"))
		if !slices.Contains(files, name) {
			files = append(files, name)
		}
	}
	return files
}
func sameFailureFile(a, b string) bool {
	a, b = path.Clean(strings.ReplaceAll(a, "\\", "/")), path.Clean(strings.ReplaceAll(b, "\\", "/"))
	return a == b || strings.HasSuffix(a, "/"+b) || strings.HasSuffix(b, "/"+a)
}
func (d *runThrash) edit(files []string) {
	d.Failures = slices.DeleteFunc(d.Failures, func(f runCheckFailure) bool {
		for _, edited := range files {
			for _, named := range f.Files {
				if sameFailureFile(edited, named) {
					return true
				}
			}
		}
		return false
	})
}
func (d *runThrash) check(id, message, status string) {
	key := "id:" + id
	if id == "" {
		key = "signature:" + failureSignature(message)
	}
	if key == "signature:" {
		return
	}
	if status == "passed" {
		d.Failures = slices.DeleteFunc(d.Failures, func(f runCheckFailure) bool { return f.Key == key })
		return
	}
	if status != "failed" {
		return
	}
	for i := range d.Failures {
		f := &d.Failures[i]
		if f.Key == key {
			f.Count = min(3, f.Count+1)
			for _, file := range failureFiles(message) {
				if !slices.Contains(f.Files, file) {
					f.Files = append(f.Files, file)
				}
			}
			return
		}
	}
	if id == "" {
		id = failureSignature(message)
	}
	d.Failures = append(d.Failures, runCheckFailure{Key: key, Check: id, Files: failureFiles(message), Count: 1})
}

// Called only after the dispatcher's pin, attempt and engine-run fences.
func projectTodoThrash(item *db.MythicalItem, update flowdispatch.ProjectionUpdate) {
	if !mythicalTodo(*item) || item.Attempt <= 0 || update.Checkpoint.RunID == "" {
		return
	}
	checks := mythicalChecksOf(*item)
	d := checks.Thrash
	if d == nil || d.Attempt != item.Attempt {
		d = &runThrash{Attempt: item.Attempt, Cursors: map[string]flowruntime.EventCursor{}, Failures: []runCheckFailure{}}
	}
	if d.Cursors == nil {
		d.Cursors = map[string]flowruntime.EventCursor{}
	}
	for _, event := range update.Events {
		if event.RunID != update.Checkpoint.RunID {
			continue
		}
		cursor := flowruntime.EventCursor{Sequence: event.Sequence}
		if event.Cursor != nil {
			cursor = *event.Cursor
		}
		if cursor.Sequence < 0 || (cursor.Offset != nil && *cursor.Offset < 0) {
			continue
		}
		if previous, ok := d.Cursors[event.RunID]; ok && !todoPlanAfter(cursor, previous) {
			continue
		}
		d.Cursors[event.RunID] = cursor
		var receipt struct {
			CheckID  string `json:"checkId"`
			Status   string `json:"status"`
			Findings []struct {
				Message string `json:"message"`
				Output  string `json:"output"`
			} `json:"findings"`
		}
		if raw := thrashNodeResult(event, "coding/check-command"); raw != nil && json.Unmarshal(raw, &receipt) == nil {
			messages := []string{}
			for _, f := range receipt.Findings {
				messages = append(messages, f.Message, f.Output)
			}
			d.check(receipt.CheckID, strings.Join(messages, "\n"), receipt.Status)
		}
		var edit struct {
			Writes []string `json:"writes"`
		}
		if raw := thrashNodeResult(event, "coding/edit-atom"); raw != nil && json.Unmarshal(raw, &edit) == nil {
			d.edit(edit.Writes)
		}
	}
	checks.Thrash = d
	item.Checks = checks.encode()
}

// Count executed leaf nodes, never their wrapper flow's duplicate result or
// cached nodes. A truncated/redacted preview cannot establish an outcome.
func thrashNodeResult(event flowruntime.Event, action string) json.RawMessage {
	if event.Kind != "control.engine.event" {
		return nil
	}
	var envelope struct {
		Version     int    `json:"version"`
		ExecutionID string `json:"executionId"`
		EventType   string `json:"eventType"`
		Payload     struct {
			NodeID  string `json:"nodeId"`
			Action  string `json:"action"`
			Outcome string `json:"outcome"`
			Result  *struct {
				Preview   string `json:"preview"`
				Truncated bool   `json:"truncated"`
			} `json:"result"`
		} `json:"payload"`
	}
	if json.Unmarshal(event.Payload, &envelope) != nil || envelope.Version != 1 || envelope.ExecutionID == "" || envelope.EventType != "flows.engine.node-settled" {
		return nil
	}
	p := envelope.Payload
	if p.NodeID == "" || p.Action != action || p.Outcome != "built" || p.Result == nil || p.Result.Truncated || !json.Valid([]byte(p.Result.Preview)) {
		return nil
	}
	return json.RawMessage(p.Result.Preview)
}
