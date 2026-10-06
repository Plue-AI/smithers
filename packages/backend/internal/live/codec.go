package live

import (
	"bytes"
	"encoding/json"
	"errors"
)

// Frame is the S1 text contract shared with @smthrs/rpc/Live.
type Frame struct {
	T      string          `json:"t"`
	ID     uint32          `json:"id"`
	Topic  string          `json:"topic,omitempty"`
	Cursor *int64          `json:"cursor,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	Where  json.RawMessage `json:"where,omitempty"`
	Code   string          `json:"code,omitempty"`
}
type frame = Frame

// DecodeRequest refuses malformed frames before changing any subscription.
func DecodeRequest(raw []byte) (Frame, error) {

	var envelope struct {
		T  string `json:"t"`
		ID uint32 `json:"id"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return Frame{}, err
	}
	if envelope.ID == 0 {
		return Frame{}, errors.New("malformed_frame")
	}
	if envelope.T == "presence" || envelope.T == "unsub" {
		var payload struct {
			Where json.RawMessage `json:"where"`
		}
		err := json.Unmarshal(raw, &payload)
		return Frame{T: envelope.T, ID: envelope.ID, Where: payload.Where}, err
	}
	var f Frame
	if err := json.Unmarshal(raw, &f); err != nil {
		return f, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return f, err
	}
	if value, ok := fields["cursor"]; ok && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return f, errors.New("malformed_frame")
	}
	if f.ID == 0 || f.Cursor != nil && (*f.Cursor < 0 || *f.Cursor > 9007199254740991) {
		return f, errors.New("malformed_frame")
	}
	switch f.T {
	case "sub":
		if f.Topic == "" {
			return f, errors.New("malformed_frame")
		}
	case "unsub", "presence":
	default:
		return f, errors.New("malformed_frame")
	}
	return f, nil
}
