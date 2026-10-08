package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/diffview"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// BurstBranchDiff reads indexed, verified snapshots only. It never wakes or
// reads the working copy, whose bytes may already belong to another actor.
func (s *WorkspaceService) BurstBranchDiff(ctx context.Context, branch string, repository, member int64, entry string) (BranchDiff, error) {
	if _, err := uuid.Parse(entry); err != nil {
		return BranchDiff{}, pkgerrors.BadRequest("invalid burst")
	}
	row, err := s.PresenceBranch(ctx, branch, repository, member)
	if err != nil {
		return BranchDiff{}, err
	}
	if s.burstPool == nil || s.burstVersions == nil {
		return BranchDiff{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "file versions unavailable")
	}
	rows, err := s.burstPool.Query(ctx, `SELECT f.path,f.change,COALESCE(f.renamed_to,''),COALESCE(f.before_blob,''),COALESCE(f.after_blob,''),COALESCE(f.post_digest,'absent'),e.data->>'versions',e.data->'actor',e.recorded_at FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.event_type='branch.burst' AND e.data->>'id'=$3 ORDER BY f.path`, fmt.Sprint(repository), "branch:"+row.ID, entry)
	if err != nil {
		return BranchDiff{}, err
	}
	defer rows.Close()
	result := BranchDiff{Files: []BranchDiffModel{}}
	type retainedFile struct {
		model         BranchDiffModel
		before, after string
	}
	retained := []retainedFile{}
	for rows.Next() {
		var f BranchDiffModel
		var before, after string
		var actor json.RawMessage
		var at time.Time
		f.Branch = branch
		if err := rows.Scan(&f.Path, &f.Change, &f.RenamedTo, &before, &after, &f.PostDigest, &f.Version, &actor, &at); err != nil {
			return BranchDiff{}, err
		}
		if err := ValidateRepositoryPath(f.Path); err != nil {
			return BranchDiff{}, err
		}
		f.Against.At = at.UTC().Format(time.RFC3339Nano)
		f.Against.Kind = "burst"
		f.Against.Burst = entry
		f.Against.Actor = actor
		f.LastWriter = actor
		retained = append(retained, retainedFile{f, before, after})
	}
	if err := rows.Err(); err != nil {
		return BranchDiff{}, err
	}
	rows.Close() // release the database connection before repository reads
	budget := 8 << 20
	for _, record := range retained {
		f, before, after := record.model, record.before, record.after
		a, err := s.readBurstBefore(ctx, repository, f.Path, f.Version, before)
		if err != nil {
			return BranchDiff{}, err
		}
		afterPath := f.Path
		if f.RenamedTo != "" {
			afterPath = f.RenamedTo
			if err := ValidateRepositoryPath(afterPath); err != nil {
				return BranchDiff{}, err
			}
		}
		b, err := s.readBurstFile(ctx, repository, "b/"+afterPath, f.Version, after)
		if err != nil {
			return BranchDiff{}, err
		}
		budget -= len(a) + len(b)
		if budget < 0 || len(a)+len(b) > 1<<20 || strings.Count(string(a), "\n") > 10000 || strings.Count(string(b), "\n") > 10000 {
			return BranchDiff{}, pkgerrors.RequestEntityTooLarge("diff exceeds limit")
		}
		f.Hunks = []BranchDiffHunk{}
		if !utf8.Valid(a) || !utf8.Valid(b) || strings.ContainsRune(string(a), '\x00') || strings.ContainsRune(string(b), '\x00') {
			f.Binary = &BranchDiffBinary{BeforeBytes: int64(len(a)), AfterBytes: int64(len(b))}
		} else {
			patch, err := diffview.UnifiedPatch(f.Path, string(a), string(b))
			if err != nil {
				return BranchDiff{}, err
			}
			for _, p := range parseCommentDiffHunks(patch) {
				h := BranchDiffHunk{OldStart: p.oldStart, NewStart: p.newStart, Lines: []BranchDiffLine{}}
				for _, l := range p.body {
					if len(l) > 0 && (l[0] == ' ' || l[0] == '+' || l[0] == '-') {
						h.Lines = append(h.Lines, BranchDiffLine{Op: l[:1], Text: l[1:]})
					}
				}
				f.Hunks = append(f.Hunks, h)
			}
		}
		result.Files = append(result.Files, f)
	}
	if len(result.Files) == 0 {
		return BranchDiff{}, pkgerrors.NotFound("burst not found")
	}
	return result, nil
}
