package services

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type wikiDeleteConfirmation struct {
	Owner      string `json:"owner"`
	Repo       string `json:"repo"`
	Visibility string `json:"visibility,omitempty"`
	page       db.GetWikiPageBySlugRow
	repository db.Repository
}

func (s *MythicalService) prepareWikiDeleteConfirmation(ctx context.Context, tx pgx.Tx, repository int64, input ConfirmationInput, inspect bool) (preparedConfirmation, error) {
	p := preparedConfirmation{}
	if s.learningWiki == nil {
		return p, confirmationUnavailable()
	}
	var subject struct {
		Kind string `json:"kind"`
		Ref  string `json:"ref"`
	}
	var request wikiDeleteConfirmation
	if confirmationJSON(input.Subject, &subject) != nil || subject.Kind != "wiki" || confirmationJSON(input.Payload, &request) != nil {
		return p, invalidConfirmation()
	}
	slug, err := normalizeWikiSlug(subject.Ref)
	if err != nil || slug != subject.Ref || request.Owner == "" || request.Repo == "" {
		return p, invalidConfirmation()
	}
	if request.Visibility == "" {
		request.Visibility = "public"
	}
	ctx, err = WithWikiVisibility(ctx, request.Visibility)
	if err != nil {
		return p, invalidConfirmation()
	}
	p.subject, _ = json.Marshal(subject)
	p.input, _ = json.Marshal(request)
	if !inspect {
		return p, nil
	}
	wiki := *s.learningWiki
	wiki.queries = db.New(tx)
	request.repository, err = wiki.resolveRepoByOwnerAndName(ctx, request.Owner, request.Repo)
	if err != nil || request.repository.ID != repository {
		return p, confirmationPermission()
	}
	info := middleware.AuthInfoFromContext(ctx)
	if err = wiki.requireWriteAccess(ctx, request.repository, info.User); err != nil {
		return p, confirmationPermission()
	}
	// The immutable page id also binds deletion/recreation under the same slug.
	if _, err = tx.Exec(ctx, `SELECT 1 FROM wiki_pages WHERE repository_id=$1 AND slug=$2 AND visibility=$3 FOR UPDATE`, repository, subject.Ref, request.Visibility); err != nil {
		return p, err
	}
	request.page, err = db.New(tx).GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{RepositoryID: repository, Slug: subject.Ref, Visibility: request.Visibility})
	if err != nil {
		return p, err
	}
	p.revision = strconv.FormatInt(request.page.ID, 10) + ":" + strconv.FormatInt(request.page.Revision, 10)
	p.title = request.page.Title
	p.wiki = &request
	p.card = map[string]any{"kind": "one_click", "action": map[string]string{"tag": "wiki.delete", "verb": "Delete"}, "summary": p.title,
		"subject": map[string]string{"kind": "wiki", "ref": subject.Ref, "revision": p.revision}, "text": request.page.Body, "asked_by": todoActor(ctx, *info.User)}
	return p, nil
}

func (s *MythicalService) deleteConfirmedWiki(ctx context.Context, tx pgx.Tx, request *wikiDeleteConfirmation) (func(), error) {
	if s.learningWiki == nil || request == nil {
		return nil, confirmationUnavailable()
	}
	ctx, err := WithWikiVisibility(ctx, request.Visibility)
	if err != nil {
		return nil, err
	}
	wiki := *s.learningWiki
	wiki.queries, wiki.documents, wiki.dispatcher = db.New(tx), db.New(tx), nil
	actor := middleware.AuthInfoFromContext(ctx).User
	if err = wiki.DeleteWikiPageAtRevision(ctx, actor, request.Owner, request.Repo, request.page.Slug, request.page.Revision); err != nil {
		return nil, err
	}
	// Publish only after both the delete and the confirmation CAS commit.
	return func() {
		s.learningWiki.dispatchWikiEvent(ctx, request.repository, actor, "deleted", mapWikiPage(request.page))
	}, nil
}
