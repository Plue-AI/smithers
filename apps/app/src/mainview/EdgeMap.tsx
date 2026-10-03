import type { EdgeMapProps } from "@smthrs/rpc/ToastCard"
import { Edge } from "./cards/views/EdgeGroupView"
export function EdgeMap({ above, below, narrow, onAction, onView }: EdgeMapProps) {
  return <div className="mvp-edge-map"><Edge entries={above} direction="above" narrow={narrow} onAction={onAction} onView={onView} /><Edge entries={below} direction="below" narrow={narrow} onAction={onAction} onView={onView} /></div>
}
