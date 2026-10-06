package routes

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"regexp"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type workspaceFileBatchRouteService interface {
	WriteWorkspaceFiles(context.Context, string, int64, int64, []workspaceapi.FileMutation) (*services.WorkspaceFileWriteResult, error)
}

var workspaceBaseDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Raw values distinguish omitted content from an intentional deletion, and
// reject even null single-file fields mixed into a batch request.
type workspaceFileValue struct {
	Content    json.RawMessage `json:"content"`
	BaseDigest json.RawMessage `json:"base_digest"`
	Encoding   json.RawMessage `json:"encoding"`
}

type writeWorkspaceFileRequest struct {
	workspaceFileValue
	Changes json.RawMessage `json:"changes"`
}

func (value workspaceFileValue) decode(path string, allowDelete bool) (workspaceapi.FileMutation, *pkgerrors.APIError) {
	change := workspaceapi.FileMutation{Path: path}
	if json.Unmarshal(value.BaseDigest, &change.BaseDigest) != nil || (change.BaseDigest != "absent" && !workspaceBaseDigestPattern.MatchString(change.BaseDigest)) {
		return change, pkgerrors.BadRequest("base_digest must be a SHA-256 digest or absent")
	}
	encoding := "utf-8"
	if value.Encoding != nil {
		if bytes.Equal(value.Encoding, []byte("null")) || json.Unmarshal(value.Encoding, &encoding) != nil || (encoding != "utf-8" && encoding != "base64") {
			return change, pkgerrors.BadRequest("encoding must be utf-8 or base64")
		}
	}
	if bytes.Equal(value.Content, []byte("null")) {
		if !allowDelete || value.Encoding != nil {
			return change, pkgerrors.BadRequest("null content requires a batch deletion without encoding")
		}
		return change, nil
	}
	var text string
	if json.Unmarshal(value.Content, &text) != nil {
		return change, pkgerrors.BadRequest("content is required and must be a string or batch deletion")
	}
	change.Content = []byte(text)
	if encoding == "base64" {
		decoded, err := base64.StdEncoding.Strict().DecodeString(text)
		// Require canonical encoding, including padding and no ignored newlines.
		if err != nil || base64.StdEncoding.EncodeToString(decoded) != text {
			return change, pkgerrors.BadRequest("content must be canonical base64")
		}
		change.Content = decoded
	}
	return change, nil
}

func decodeWorkspaceFileChanges(raw json.RawMessage) ([]workspaceapi.FileMutation, *pkgerrors.APIError) {
	var input []struct {
		workspaceFileValue
		Path string `json:"path"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decodeSingleJSONDocument(decoder, &input) != nil || len(input) == 0 || len(input) > services.MaxWorkspaceFileChanges {
		return nil, pkgerrors.BadRequest("changes must contain 1 to 256 file changes with no unknown fields")
	}
	changes := make([]workspaceapi.FileMutation, len(input))
	for i, value := range input {
		change, err := value.workspaceFileValue.decode(value.Path, true)
		if err != nil {
			return nil, err
		}
		changes[i] = change
	}
	return changes, nil
}
