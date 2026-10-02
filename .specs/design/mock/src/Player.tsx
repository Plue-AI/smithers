/*
 * The review harness around the product: journey tabs, transport, step ticks
 * and the caption. It is deliberately not Paper so nobody mistakes it for the
 * app. Keys: Space play/pause, ← → step, T theme, 1–9 journey.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { AppFrame, type Pointer } from "./AppFrame"
import { GitHubFrame } from "./GitHubFrame"
import { DEFAULT_HOLD, POINTER_MS, KEY_MS, stateBefore, stateDuring, type Journey, type Typing } from "./journey"
import { JOURNEYS } from "./journeys"
import { member, type ActorId, type State } from "./world"

const params = new URLSearchParams(location.search)
const still = params.get("still") === "1"
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frameTick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

/** Wait until a smooth scroll has carried the element to rest (or 900 ms pass). */
const settled = async (element: Element): Promise<void> => {
  let last = element.getBoundingClientRect().top
  for (let waited = 0; waited < 900; waited += 60) {
    await sleep(60)
    const now = element.getBoundingClientRect().top
    if (Math.abs(now - last) < 0.5) return
    last = now
  }
}

const journeyById = (id: string | null): Journey => JOURNEYS.find(each => each.id === id) ?? JOURNEYS[0]!

export const Player = () => {
  const [journey, setJourney] = useState<Journey>(() => journeyById(params.get("j")))
  const [index, setIndex] = useState(() => Math.max(0, Math.min(Number(params.get("s") ?? 0), journey.steps.length)))
  const [state, setState] = useState<State>(() => stateBefore(journey, index))
  const [playingStep, setPlayingStep] = useState<number | undefined>()
  const [playing, setPlaying] = useState(!still)
  const [typed, setTyped] = useState<{ byViewer: Record<ActorId, Record<string, string>>; shared: Record<string, string> }>()
  const [pointer, setPointer] = useState<{ viewer: ActorId } & Pointer>()
  const [keys, setKeys] = useState<{ viewer: ActorId; keys: string }>()
  const [theme, setTheme] = useState<"light" | "dark">(params.get("theme") === "dark" ? "dark" : "light")
  const [speed, setSpeed] = useState(1)
  const run = useRef(0)
  const indexRef = useRef(index)
  indexRef.current = index

  useLayoutEffect(() => { document.documentElement.dataset.theme = theme }, [theme])

  const syncUrl = (journeyId: string, at: number) => {
    const next = new URLSearchParams(location.search)
    next.set("j", journeyId)
    next.set("s", String(at))
    next.delete("still")
    history.replaceState(null, "", `?${next}`)
  }

  const jump = (target: Journey, at: number) => {
    run.current += 1
    setTyped(undefined)
    setKeys(undefined)
    setPointer(undefined)
    setPlayingStep(undefined)
    const clamped = Math.max(0, Math.min(at, target.steps.length))
    setJourney(target)
    setIndex(clamped)
    setState(stateBefore(target, clamped))
    syncUrl(target.id, clamped)
  }

  useEffect(() => {
    if (!playing) return
    const token = ++run.current
    const alive = () => run.current === token
    const wait = (ms: number) => sleep(ms / speed)
    const play = async () => {
      for (let i = indexRef.current; i < journey.steps.length; i += 1) {
        const step = journey.steps[i]!
        const who = step.viewer ?? journey.viewers[0]!
        setPlayingStep(i)
        for (const { viewer: on, target } of step.reveal ?? []) {
          const element = document.querySelector(`[data-frame="${on}"]`)?.querySelector(target)
          if (element !== null && element !== undefined) {
            element.scrollIntoView({ block: "nearest", behavior: "smooth" })
            await settled(element)
          }
        }
        if (!alive()) return
        if (step.target !== undefined) {
          const frame = document.querySelector<HTMLElement>(`[data-frame="${who}"]`)
          const element = frame?.querySelector<HTMLElement>(step.target)
          if (frame === null || frame === undefined || element === null || element === undefined) {
            console.error(`${journey.id} step ${i + 1}: no target ${step.target} on ${who}'s screen`)
          } else {
            element.scrollIntoView({ block: "nearest", behavior: "smooth" })
            await settled(element)
            if (!alive()) return
            const box = element.getBoundingClientRect()
            const area = frame.getBoundingClientRect()
            setPointer({ viewer: who, x: box.left - area.left + Math.min(box.width * 0.5, 40), y: box.top - area.top + box.height * 0.55, pressing: false })
            await wait(POINTER_MS)
            if (!alive()) return
            if (step.hover !== true) {
              setPointer(current => current === undefined ? current : { ...current, pressing: true })
              await wait(170)
              setPointer(current => current === undefined ? current : { ...current, pressing: false })
            }
          }
        }
        if (step.pre !== undefined) {
          setState(stateDuring(journey, i))
          await frameTick()
          if (!alive()) return
        }
        if (step.keys !== undefined) {
          setKeys({ viewer: who, keys: step.keys })
          await wait(620)
          if (!alive()) return
          setKeys(undefined)
        }
        if (step.typing !== undefined) {
          const entries = Array.isArray(step.typing) ? step.typing : [step.typing as Typing]
          const longest = Math.max(...entries.map(entry => entry.text.length), 1)
          const per = Math.min(KEY_MS, 1500 / longest)
          for (let k = 1; k <= longest; k += 1) {
            const byViewer: Record<ActorId, Record<string, string>> = {}
            const shared: Record<string, string> = {}
            for (const entry of entries) {
              const value = (entry.after ?? "") + entry.text.slice(0, k)
              if (entry.shared === true) shared[entry.into] = value
              else (byViewer[entry.viewer ?? who] ??= {})[entry.into] = value
            }
            setTyped({ byViewer, shared })
            await wait(per)
            if (!alive()) return
          }
          await wait(220)
        }
        if (!alive()) return
        setTyped(undefined)
        setState(stateBefore(journey, i + 1))
        setIndex(i + 1)
        indexRef.current = i + 1
        syncUrl(journey.id, i + 1)
        await frameTick()
        for (const { viewer: on, target } of step.show ?? []) {
          document.querySelector(`[data-frame="${on}"]`)?.querySelector(target)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
        }
        await wait(step.hold ?? DEFAULT_HOLD)
        if (!alive()) return
      }
      setPlayingStep(undefined)
      setPlaying(false)
    }
    void play()
    return () => { run.current += 1 }
  }, [playing, journey, speed])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === " ") { event.preventDefault(); setPlaying(value => !value) }
      else if (event.key === "ArrowRight") { setPlaying(false); jump(journey, indexRef.current + 1) }
      else if (event.key === "ArrowLeft") { setPlaying(false); jump(journey, indexRef.current - 1) }
      else if (event.key.toLowerCase() === "t") setTheme(value => value === "light" ? "dark" : "light")
      else if (/^[1-9]$/.test(event.key)) {
        const target = JOURNEYS[Number(event.key) - 1]
        if (target !== undefined) { setPlaying(false); jump(target, 0) }
      }
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  })

  const shown = playingStep ?? (index > 0 ? index - 1 : undefined)
  /* On a phone a split reel shows one screen: the one the current step happens on. */
  const active = (shown === undefined ? undefined : journey.steps[shown]?.viewer) ?? journey.viewers[0]
  const caption = shown === undefined ? journey.intro : journey.steps[shown]?.caption
  const split = journey.viewers.length > 1
  return (
    <div className="mock-root">
      <div className="mock-player" role="toolbar" aria-label="Design review player">
        <div className="mock-bar">
          <span className="mock-brand">Smithers MVP <i>design</i></span>
          {/* Fifteen reels: one select keeps the bar to one line; 1–9 still jump straight to a reel. */}
          <label className="mock-journeys">
            <span className="mock-journeys-label">Reel</span>
            <select aria-label="Reel" value={journey.id} onChange={event => {
              const next = JOURNEYS.find(each => each.id === event.target.value)
              if (next !== undefined) { setPlaying(true); jump(next, 0) }
            }}>
              {JOURNEYS.map(each => <option key={each.id} value={each.id}>{each.id.toUpperCase()} · {each.title}</option>)}
            </select>
          </label>
          <div className="mock-transport">
            <button type="button" aria-label="Restart" title="Restart" onClick={() => { jump(journey, 0); setPlaying(true) }}>↺</button>
            <button type="button" aria-label="Previous step" title="Previous step (←)" onClick={() => { setPlaying(false); jump(journey, index - 1) }}>‹</button>
            <button type="button" className="mock-play" aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)"
              onClick={() => { if (!playing && index >= journey.steps.length) jump(journey, 0); setPlaying(value => !value) }}>{playing ? "❚❚" : "▶"}</button>
            <button type="button" aria-label="Next step" title="Next step (→)" onClick={() => { setPlaying(false); jump(journey, index + 1) }}>›</button>
            <span className="mock-count">{index}/{journey.steps.length}</span>
          </div>
          <div className="mock-ticks" aria-label="Steps">
            {journey.steps.map((step, i) => (
              <button key={i} type="button" title={`${i + 1}. ${step.caption}`} aria-label={`Step ${i + 1}`}
                data-done={i < index || undefined} data-current={i === playingStep || undefined}
                onClick={() => { setPlaying(false); jump(journey, i + 1) }} />
            ))}
          </div>
          <div className="mock-options">
            <button type="button" onClick={() => setSpeed(value => value === 1 ? 2 : value === 2 ? 0.5 : 1)} title="Playback speed">{speed}×</button>
            <button type="button" onClick={() => setTheme(value => value === "light" ? "dark" : "light")} title="Theme (T)">{theme === "light" ? "Dark" : "Light"}</button>
          </div>
        </div>
        <p className="mock-caption"><span className="mock-spec" title="Spec">{(shown === undefined ? undefined : journey.steps[shown]?.spec) ?? journey.spec}</span>{caption}</p>
      </div>
      <div className="mock-stage" data-split={split || undefined}>
        {journey.viewers.map(who => (
          <div key={who} className="mock-frame" data-active={who === active || undefined}>
            {split ? <span className="mock-frame-label">{who === "github" ? "GitHub" : `${member(state.world, who)?.name.split(" ")[0]}'s screen`}</span> : null}
            {who === "github"
              ? <GitHubFrame frame={{ state, me: who, typed: { ...typed?.shared, ...typed?.byViewer[who] } }} pr={journey.githubPr ?? 0} />
              : <AppFrame frame={{ state, me: who, typed: { ...typed?.shared, ...typed?.byViewer[who] } }}
                  pointer={pointer?.viewer === who ? pointer : undefined}
                  keys={keys?.viewer === who ? keys.keys : undefined} />}
            {who === "github" && pointer?.viewer === who ? <div className="mock-pointer" data-pressing={pointer.pressing || undefined}
              style={{ transform: `translate(${pointer.x}px, ${pointer.y}px)` }} aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8.2-6.4 1.5L8.4 18z" fill="#211d18" stroke="#fffefa" strokeWidth="1.4" strokeLinejoin="round" /></svg></div> : null}
          </div>
        ))}
      </div>
    </div>
  )
}
