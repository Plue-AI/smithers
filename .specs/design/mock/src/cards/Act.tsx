/*
 * A✓ (mvp.md Appendix B): the app agent's one-click confirmation. Asked to
 * start, change or stop work, it posts exactly what it will do, and nothing
 * happens until the person who asked presses it (⏎ from the keyboard). It is
 * private to that person; nobody else in the conversation sees it. Pressed, it is a receipt.
 */
import { Button } from "@smthrs/ui"
import { Check } from "lucide-react"
import { Card, Kbd, actorName } from "../parts"
import { useFrame } from "../frame"
import type { ExtraCardProps } from "./extra"

export const ActCard = ({ id, target }: ExtraCardProps) => {
  const { state: { world, seq }, me } = useFrame()
  const act = world.acts.find(each => each.id === target)
  if (act === undefined || act.by !== me) return null
  const done = act.state === "done"
  return (
    <Card id={id} kind="act" title={done ? act.receipt : `${act.verb} ${act.target}?`}>
      {act.text === undefined ? null : <p className="mvp-act-text" data-copy="data">{act.text}</p>}
      {done ? <p className="mvp-receipt-line" data-fresh={act.seq === seq || undefined}><Check size={14} aria-hidden="true" />{actorName(world, act.by)}</p>
        : act.state === "cancelled" ? <p className="mvp-meta">Cancelled</p>
        : (
          <div className="mvp-actions">
            <span className="mvp-actions-end">
              <Button size="sm" variant="ghost" data-mock={`act-cancel-${act.id}`}>Cancel</Button>
              <Button size="sm" variant="solid" data-mock={`act-${act.id}`}>{act.verb}<Kbd>⏎</Kbd></Button>
            </span>
          </div>
        )}
    </Card>
  )
}
