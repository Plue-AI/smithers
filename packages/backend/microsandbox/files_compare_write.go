package microsandbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const guestMutationByteLimit = 1 << 20

// compareWriteFiles is the private transport candidate, not the qualified
// WorkspaceCompareWriter capability. The installed guest still refuses this
// operation. Enabling the exported capability requires the security receipts.
func (r *Runtime) compareWriteFiles(ctx context.Context, workspaceID string, changes []workspaceapi.FileMutation) error {
	if len(changes) == 0 || len(changes) > 256 {
		return errors.New("invalid workspace mutation count")
	}
	type change struct {
		Path       string  `json:"path"`
		BaseDigest string  `json:"base_digest"`
		Content    *string `json:"content"`
		Encoding   string  `json:"encoding,omitempty"`
	}
	request := struct {
		Changes []change `json:"changes"`
	}{Changes: make([]change, len(changes))}
	expected := make(map[string]string, len(changes))
	total := 0
	for i, input := range changes {
		name := input.Path
		if name == "" || len(name) > 4096 || name == "." || path.IsAbs(name) || path.Clean(name) != name || name == ".." || strings.HasPrefix(name, "../") || strings.ContainsRune(name, 0) {
			return errors.New("invalid workspace mutation path")
		}
		if _, duplicate := expected[name]; duplicate {
			return errors.New("duplicate workspace mutation path")
		}
		if input.BaseDigest != "absent" && !sha256Pattern.MatchString(input.BaseDigest) {
			return errors.New("invalid workspace mutation base")
		}
		if len(input.Content) > guestMutationByteLimit-total {
			return errors.New("workspace mutation exceeds byte limit")
		}
		total += len(input.Content)
		request.Changes[i] = change{Path: name, BaseDigest: input.BaseDigest}
		expected[name] = "absent"
		if input.Content != nil {
			encoded := base64.StdEncoding.EncodeToString(input.Content)
			request.Changes[i].Content = &encoded
			request.Changes[i].Encoding = "base64"
			expected[name] = fmt.Sprintf("%x", sha256.Sum256(input.Content))
		}
	}
	for name := range expected {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if _, overlap := expected[parent]; overlap {
				return errors.New("overlapping workspace mutation paths")
			}
		}
	}
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	output, err := r.fileOperation(ctx, workspaceID, guestRoot, body, "compare-write", strconv.Itoa(guestMutationByteLimit))
	if err != nil {
		var stale *workspaceapi.StaleFileError
		if errors.As(err, &stale) {
			if _, present := expected[stale.Path]; !present {
				return fmt.Errorf("%w: unexpected stale mutation path", ErrUnavailable)
			}
		}
		return err
	}
	var response struct {
		Changes []struct {
			Path   string `json:"path"`
			Digest string `json:"digest"`
		} `json:"changes"`
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.DisallowUnknownFields()
	if len(output) > 2<<20 || decoder.Decode(&response) != nil || decoder.Decode(new(any)) != io.EOF || len(response.Changes) != len(changes) {
		return fmt.Errorf("%w: invalid mutation acknowledgment", ErrUnavailable)
	}
	for _, result := range response.Changes {
		if digest, ok := expected[result.Path]; !ok || digest != result.Digest {
			return fmt.Errorf("%w: mismatched mutation acknowledgment", ErrUnavailable)
		}
		delete(expected, result.Path)
	}
	return nil
}
