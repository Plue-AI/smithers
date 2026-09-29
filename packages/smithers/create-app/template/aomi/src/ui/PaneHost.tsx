/**
 * Renders one `PaneCard` from the pane registry.
 *
 * EMBED LAW: a pane is always shown embedded in the transcript first. When the
 * pane declares `fullscreen`, the card header offers a maximize control, and
 * the maximized presentation is the same component in a fixed overlay with a
 * restore control. The host and pane stay mounted; context updates may render
 * the pane again without creating another instance.
 *
 * Props arrive over the wire as `unknown` and are decoded with the pane's own
 * schema. A decode failure renders one plain sentence instead of throwing
 * through the transcript; the schema's own text stays behind a collapsed
 * Details control for the pane's author.
 */
import type { AnyPaneDefinition, PaneCard, PaneContext, PaneRegistry } from "@smthrs/create-app/ui"
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@smthrs/ui"
import type { ReactNode } from "react"

export interface PaneHostProps {
  readonly card: PaneCard
  readonly panes: PaneRegistry
  /** Present this mounted host as a fullscreen overlay. */
  readonly maximized?: boolean
  readonly onMaximize?: (cardId: string) => void
  readonly onRestore?: () => void
}

interface Rendered {
  readonly ok: boolean
  readonly node: ReactNode
  readonly message: string
}

/**
 * `renderUnknown` decodes the wire props with the pane's own schema and renders
 * them, throwing the schema's error when they are rejected. Catching it here is
 * what keeps a bad card from taking the transcript down with it.
 */
const renderPane = (definition: AnyPaneDefinition, props: unknown, context: PaneContext): Rendered => {
  try {
    return { ok: true, node: definition.renderUnknown(props, context), message: "" }
  } catch (cause) {
    return { ok: false, node: null, message: cause instanceof Error ? cause.message : String(cause) }
  }
}

function Frame({
  title,
  maximized,
  canMaximize,
  onMaximize,
  onRestore,
  children
}: {
  readonly title: string
  readonly maximized: boolean
  readonly canMaximize: boolean
  readonly onMaximize: (() => void) | undefined
  readonly onRestore: (() => void) | undefined
  readonly children: ReactNode
}) {
  return (
    <Card className="aomi-pane">
      <CardHeader className="aomi-pane-header">
        <CardTitle>{title}</CardTitle>
        {maximized ? (
          <Button variant="ghost" size="sm" onClick={onRestore}>
            Restore
          </Button>
        ) : canMaximize && onMaximize !== undefined ? (
          <Button variant="ghost" size="sm" onClick={onMaximize}>
            Maximize
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="aomi-pane-body">{children}</CardContent>
    </Card>
  )
}

export function PaneHost({ card, panes, maximized = false, onMaximize, onRestore }: PaneHostProps) {
  const definition = (panes as Record<string, AnyPaneDefinition | undefined>)[card.name]
  if (definition === undefined) {
    return (
      <EmptyState
        title="Unknown pane"
        description={`No pane named "${card.name}" is registered in app/panes.`}
      />
    )
  }
  const title = card.title ?? definition.title ?? card.name
  const canMaximize = definition.fullscreen
  const context: PaneContext = {
    fullscreen: maximized,
    maximize: () => onMaximize?.(card.id),
    restore: () => onRestore?.()
  }
  const rendered = renderPane(definition, card.props, context)
  const body = rendered.ok ? (
    rendered.node
  ) : (
    <>
      <EmptyState title="Pane props rejected" description="This card sent data the pane cannot show." />
      <details className="aomi-pane-detail">
        <summary>Details</summary>
        <pre>{rendered.message}</pre>
      </details>
    </>
  )
  const frame = (
    <Frame
      title={title}
      maximized={maximized}
      canMaximize={canMaximize}
      onMaximize={onMaximize === undefined ? undefined : () => onMaximize(card.id)}
      onRestore={onRestore}
    >
      {body}
    </Frame>
  )
  return (
    <div
      className={maximized ? "aomi-pane-overlay" : undefined}
      role={maximized ? "dialog" : undefined}
      aria-modal={maximized ? true : undefined}
      aria-label={maximized ? title : undefined}
    >
      <div className={maximized ? "aomi-pane-overlay-inner" : undefined}>{frame}</div>
    </div>
  )
}
