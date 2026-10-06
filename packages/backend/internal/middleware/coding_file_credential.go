package middleware

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// CodingFileProfileS1 grants only one exact file-content batch. It does not
// grant terminal, source-publication, repository administration or approvals.
const CodingFileProfileS1 = "coding_file_s1"

const codingFilePrefix = "coding-file-"

var codingRunPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)
var codingDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// CodingFileBinding is issuer-owned metadata on a short-lived access token.
// Run is asserted by the authenticated S1 host, never by the file-write body.
// Fence binds the grant to the host credential generation without disclosing it.
type CodingFileBinding struct {
	HostID, WorkspaceID, RunID, BatchDigest, Fence string
	RepositoryID                                   int64
}

func (b CodingFileBinding) Valid() bool {
	host, err := uuid.Parse(b.HostID)
	if err != nil || host.String() != b.HostID {
		return false
	}
	workspace, err := uuid.Parse(b.WorkspaceID)
	return err == nil && workspace.String() == b.WorkspaceID && b.RepositoryID > 0 &&
		codingRunPattern.MatchString(b.RunID) && codingDigestPattern.MatchString(b.BatchDigest) && codingDigestPattern.MatchString(b.Fence)
}

// CodingFileScopes uses existing delegated/run/repository bindings plus an
// exact request digest and host fence. None of the metadata grants permission.
func CodingFileScopes(b CodingFileBinding) []string {
	return []string{string(ScopeWriteRepository), RepositoryRestrictionScope(b.RepositoryID),
		"via:smithers", "profile:" + CodingFileProfileS1, "branch:" + b.WorkspaceID,
		AgentSessionRestrictionScope(b.RunID), codingFilePrefix + "host:" + b.HostID,
		codingFilePrefix + "batch:" + b.BatchDigest, codingFilePrefix + "fence:" + b.Fence}
}

// IsCodingFileCredential also recognizes malformed marked credentials so a
// broken restriction cannot silently become an ordinary write token.
func IsCodingFileCredential(info *AuthInfo) bool {
	if info == nil || !info.IsTokenAuth {
		return false
	}
	for _, entry := range tokenScopeEntries(info.RawScopes) {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry == "profile:"+CodingFileProfileS1 || strings.HasPrefix(entry, codingFilePrefix) {
			return true
		}
	}
	return false
}

func CodingFileCredential(info *AuthInfo) (CodingFileBinding, bool) {
	var b CodingFileBinding
	if !IsCodingFileCredential(info) || !info.TokenSystemIssued || info.CredentialKind() != CredentialDelegated {
		return b, false
	}
	entries := map[string]string{}
	for _, entry := range tokenScopeEntries(info.RawScopes) {
		key, value, found := strings.Cut(strings.TrimSpace(entry), ":")
		if !found {
			return b, false
		}
		key = strings.ToLower(key)
		if _, duplicate := entries[key]; duplicate {
			return b, false
		}
		entries[key] = value
	}
	if len(entries) != 9 || entries["write"] != "repository" || entries["via"] != "smithers" || entries["profile"] != CodingFileProfileS1 {
		return b, false
	}
	b.HostID, b.WorkspaceID, b.RunID = entries["coding-file-host"], entries["branch"], entries["agent-session"]
	b.BatchDigest, b.Fence = entries["coding-file-batch"], entries["coding-file-fence"]
	b.RepositoryID, _ = strconv.ParseInt(entries["repo"], 10, 64)
	return b, b.Valid() && entries["repo"] == strconv.FormatInt(b.RepositoryID, 10)
}

func CodingFileBatchVerified(info *AuthInfo, digest string) bool {
	return info != nil && digest != "" && info.verifiedCodingFileBatch == digest
}

// allowCodingFileCredential runs before routing. Even a leaked grant can only
// replay its exact bounded PUT body at its bound workspace's file route.
func allowCodingFileCredential(w http.ResponseWriter, r *http.Request, info *AuthInfo) bool {
	if !IsCodingFileCredential(info) {
		return true
	}
	refuse := func() bool {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("{\"class\":\"permission\",\"code\":\"permission\",\"message\":\"Coding file grant refused\"}\n"))
		return false
	}
	binding, valid := CodingFileCredential(info)
	parts := strings.Split(r.URL.EscapedPath(), "/")
	if !valid || r.Method != http.MethodPut || r.URL.RawQuery != "" || len(parts) != 9 ||
		parts[1] != "api" || parts[2] != "repos" || parts[3] == "" || parts[4] == "" ||
		parts[5] != "workspaces" || parts[6] != binding.WorkspaceID || parts[7] != "files" || parts[8] != "content" || r.Body == nil {
		return refuse()
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
	_ = r.Body.Close()
	if err != nil || len(data) > 1024*1024 {
		return refuse()
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != binding.BatchDigest {
		return refuse()
	}
	r.Body = io.NopCloser(bytes.NewReader(data))
	info.verifiedCodingFileBatch = binding.BatchDigest
	return true
}
