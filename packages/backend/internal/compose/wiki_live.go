package compose

import (
	"context"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"strings"
)

func composeWikiHost(ctx context.Context, library *livedocument.Library, q *db.Queries, wiki *services.WikiService) *live.WikiHost {
	h := live.NewWikiHost(ctx, library)
	h.Acquire = q.LeaseWikiDocument
	resolve := func(ctx context.Context, repository, page, member int64, write bool) (db.GetWikiDocumentRow, error) {
		role, err := services.InstallRoleOf(ctx, q, member)
		if err != nil {
			return db.GetWikiDocumentRow{}, err
		}
		if role == "" {
			return db.GetWikiDocumentRow{}, errors.New("not an install member")
		}
		bound, slug, err := installRepository(ctx, q)
		if err != nil {
			return db.GetWikiDocumentRow{}, err
		}
		if bound != repository {
			return db.GetWikiDocumentRow{}, errors.New("not an install member")
		}
		location, visibility, err := q.WikiDocumentLocation(ctx, repository, page)
		if err != nil {
			return db.GetWikiDocumentRow{}, err
		}
		actor, err := q.GetUserByID(ctx, member)
		if err != nil {
			return db.GetWikiDocumentRow{}, err
		}
		names := strings.SplitN(slug, "/", 2)
		return wiki.OpenLiveWiki(ctx, &actor, names[0], names[1], location, visibility, page, write)
	}
	h.Open = resolve
	h.Commit = func(ctx context.Context, member int64, row db.GetWikiDocumentRow, state, vector []byte, text string) (db.GetWikiDocumentRow, error) {
		if _, err := resolve(ctx, row.RepositoryID, row.ID, member, true); err != nil {
			return row, err
		}
		_, slug, err := installRepository(ctx, q)
		if err != nil {
			return row, err
		}
		actor, err := q.GetUserByID(ctx, member)
		if err != nil {
			return row, err
		}
		names := strings.SplitN(slug, "/", 2)
		return wiki.CommitLiveWiki(ctx, &actor, names[0], names[1], row, state, vector, text, func(state, local []byte) ([]byte, []byte, string, error) {
			doc, err := library.Open(livedocument.Wiki, state)
			if err != nil {
				return nil, nil, "", err
			}
			defer doc.Close()
			if _, err = doc.Peer(local); err != nil {
				return nil, nil, "", err
			}
			combined, err := doc.State()
			if err != nil {
				return nil, nil, "", err
			}
			vector, err := doc.Sync1()
			if err != nil {
				return nil, nil, "", err
			}
			text, err := doc.Text("markdown")
			return combined, vector, text, err
		})
	}
	return h
}
