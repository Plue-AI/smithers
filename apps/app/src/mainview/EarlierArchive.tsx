import type { ReactNode, MouseEvent } from "react"
import type { BranchTreeNodeCard } from "@smthrs/rpc/BranchTreeNodeCard"
export type EarlierArchiveView = { selected_archive?: string }
export type EarlierArchiveProps = { model: { node: BranchTreeNodeCard & { kind: "earlier"; archive_count: number }; archives: { id: string; title: string; entries: ReactNode[] }[]; read_only: true }; view: EarlierArchiveView; onView: (patch: Partial<EarlierArchiveView>) => void }

export function EarlierArchive({ model, view, onView }: EarlierArchiveProps) {
  const selectArchive = (event: MouseEvent<HTMLButtonElement>) => onView({ selected_archive: event.currentTarget.dataset.archive })
  const selected = model.archives.find(archive => archive.id === view.selected_archive)
  return <section className="mvp-earlier" aria-label="Earlier" data-keyboard-pane="Earlier">
    <header>
    <span>Earlier · {model.node.archive_count}
    </span>
    <span className="mvp-read-only">Read-only</span>
    </header>
    <nav aria-label="Archives">{model.archives.map(archive => <button key={archive.id} type="button" data-archive={archive.id} aria-current={archive.id === view.selected_archive ? "page" : undefined} onClick={selectArchive}>{archive.title}
    </button>)}
    </nav>{selected ? <div className="mvp-archive-entries">{selected.entries}
    </div> : null}
    </section>
}
