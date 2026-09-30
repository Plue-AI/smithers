/**
 * The root page. `app/page.tsx` is the route `/`; `app/settings/page.tsx` would
 * be `/settings`. Nothing registers a page but its location.
 *
 * The composer posts to `/api/turn` and reads the `TurnFrame` NDJSON stream
 * back: `done.output.answer` is the final answer, each `card` renders through the pane
 * registry, and an `error` frame or a refused request shows as one line. A
 * failure the page catches itself shows one plain sentence, with its raw text
 * behind a collapsed Details control.
 *
 * A deployed Worker refuses a turn without `APP_API_TOKEN`. Open the app once
 * as `/#token=<value>`: the fragment never leaves the browser, and
 * {@link authHeaders} moves it into this tab's sessionStorage.
 *
 * The registry comes from `routes.ui.gen.ts`, imported when a turn starts: that
 * module imports this page, so a top-level import would close a cycle.
 */
import type { AppCard, PaneRegistry, TurnFrame } from "@smthrs/create-app/ui"
import { type ReactNode, useRef, useState } from "react"

interface Turn {
  readonly text: string
  readonly cards: ReadonlyArray<AppCard>
  readonly error?: string
  readonly detail?: string
}

const empty: Turn = { text: "", cards: [] }

const apply = (turn: Turn, frame: TurnFrame): Turn => {
  switch (frame.type) {
    case "done": {
      const output = frame.output
      const answer = typeof output === "object" && output !== null && "answer" in output
        ? output.answer
        : undefined
      return { ...turn, text: typeof answer === "string" ? answer : "" }
    }
    case "card":
      return { ...turn, cards: [...turn.cards, frame.card] }
    case "card.update": {
      const index = turn.cards.findIndex((card) => card.id === frame.card.id)
      return { ...turn, cards: index === -1
        ? [...turn.cards, frame.card]
        : turn.cards.map((card, at) => at === index ? frame.card : card) }
    }
    case "error":
      return { ...turn, error: frame.message }
    default:
      return turn
  }
}

const tokenKey = "app.api-token"

/** The `Authorization` header for `/api/turn`, claiming `#token=` on first use. */
const authHeaders = (): Record<string, string> => {
  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const supplied = fragment.get("token")
    if (supplied !== null) {
      fragment.delete("token")
      const url = new URL(window.location.href)
      url.hash = fragment.toString()
      window.history.replaceState(window.history.state, "", url)
      if (supplied !== "") window.sessionStorage.setItem(tokenKey, supplied)
    }
    const token = window.sessionStorage.getItem(tokenKey)
    return token === null ? {} : { authorization: `Bearer ${token}` }
  } catch {
    return {}
  }
}

const noContext = { fullscreen: false, maximize: () => {}, restore: () => {} }

const rawText = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/** One plain sentence, and the raw text only behind a collapsed Details control. */
const Failure = ({ sentence, detail }: { readonly sentence: string; readonly detail?: string | undefined }) => (
  <>
    <p className="answer-error">{sentence}</p>
    {detail === undefined ? null : (
      <details className="answer-detail">
        <summary>Details</summary>
        <pre>{detail}</pre>
      </details>
    )}
  </>
)

/**
 * The `srcDoc` for a `ui/html` card: the model's fragment behind a CSP that
 * blocks every subresource. `sandbox=""` on the frame already stops scripts,
 * forms, and navigation, but a srcdoc document inherits no policy, so without
 * this an `<img src>` in the fragment could still send data to any host.
 */
const htmlCardDocument = (html: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">${html}`

const renderCard = (card: AppCard, panes: PaneRegistry): ReactNode => {
  if (card.kind === "html") {
    return (
      <div className="pane">
        {card.title === undefined ? null : <h3 className="pane-heading">{card.title}</h3>}
        <iframe className="html-card" title={card.title ?? "Output"} sandbox="" srcDoc={htmlCardDocument(card.html)} />
      </div>
    )
  }
  if (card.kind !== "pane") return null
  const pane = panes[card.name]
  if (pane === undefined) return <p className="answer-error">No pane is routed as {card.name}</p>
  try {
    return pane.renderUnknown(card.props, noContext)
  } catch (cause) {
    return <Failure sentence="This card sent data the pane cannot show." detail={rawText(cause)} />
  }
}

export default function Page() {
  const [message, setMessage] = useState("")
  const [turn, setTurn] = useState<Turn | undefined>(undefined)
  const [panes, setPanes] = useState<PaneRegistry>({})
  const [pending, setPending] = useState(false)
  const busy = useRef(false)

  const send = async () => {
    if (busy.current || message.trim() === "") return
    busy.current = true
    setPending(true)
    setTurn(empty)
    try {
      setPanes((await import("../routes.ui.gen.ts")).panes)
      const response = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ flow: "chat", payload: { message } })
      })
      if (!response.ok || response.body === null) {
        const body = await response.json().catch(() => undefined) as { message?: string } | undefined
        setTurn({ ...empty, error: body?.message ?? `HTTP ${response.status}` })
        return
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffered = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffered += value
        const lines = buffered.split("\n")
        buffered = lines.pop() ?? ""
        for (const line of lines) {
          if (line.length > 0) setTurn((current) => apply(current ?? empty, JSON.parse(line) as TurnFrame))
        }
      }
    } catch (cause) {
      setTurn({ ...empty, error: "The app did not answer. Try again.", detail: rawText(cause) })
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  return (
    <section className="page">
      <h1>Chat</h1>
      <p className="page-lede">
        One flow, one pane, one tool. Edit <code>flows/chat/flow.ts</code> to change what the agent is asked, and{" "}
        <code>AGENT.ts</code> to change the seat it runs on.
      </p>
      <div className="composer">
        <input
          className="composer-input"
          value={message}
          placeholder="Ask something"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send()
          }}
        />
        <button className="composer-send" type="button" disabled={pending} onClick={() => void send()}>
          {pending ? "Running" : "Send"}
        </button>
      </div>
      {turn === undefined ? null : (
        <div className="answer">
          {turn.text === "" ? null : <p className="answer-text">{turn.text}</p>}
          {turn.cards.map((card) => <div key={card.id}>{renderCard(card, panes)}</div>)}
          {turn.error === undefined ? null : <Failure sentence={turn.error} detail={turn.detail} />}
        </div>
      )}
    </section>
  )
}
