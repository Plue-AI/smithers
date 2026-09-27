/**
 * Thompson matching for the validated ASCII search grammar. Each state is
 * visited once per input position; alternatives never backtrack over input.
 *
 * @since 1.0.0
 */

type Term =
  | { readonly kind: "atom"; readonly source: string }
  | { readonly kind: "sequence" | "alternative"; readonly terms: ReadonlyArray<Term> }
  | { readonly kind: "repeat"; readonly term: Term; readonly min: number; readonly max: number }

type State =
  | { readonly kind: "atom"; readonly expression: RegExp; readonly next: number }
  | { readonly kind: "start" | "end"; readonly next: number }
  | { readonly kind: "split"; readonly next: ReadonlyArray<number> }
  | { readonly kind: "accept" }

/**
 * Compiles an already syntax-validated pattern. Compilation is bounded to
 * 8192 states and 128 nested groups, including expanded counted repetitions.
 * The iterator yields every 4096 state visits so the host can dispatch timers
 * and interruption even for long lines and expensive linear matches.
 *
 * @private
 * @since 1.0.0
 */
export const compile = (
  pattern: string,
  insensitive: boolean
): { readonly test: (line: string) => Generator<void, boolean> } => {
  let offset = 0
  const parse = (depth: number): Term => {
    if (depth > 128) throw new Error("patterns must not exceed 128 nested groups")
    const alternatives: Array<Term> = []
    let sequence: Array<Term> = []
    while (offset < pattern.length && pattern[offset] !== ")") {
      const start = offset
      const character = pattern[offset++]!
      if (character === "|") {
        alternatives.push({ kind: "sequence", terms: sequence })
        sequence = []
        continue
      }
      let term: Term
      if (character === "(") {
        term = parse(depth + 1)
        offset++
      } else {
        if (character === "\\") offset++
        if (character === "[") {
          while (pattern[offset] !== "]") {
            if (pattern[offset++] === "\\") offset++
          }
          offset++
        }
        term = { kind: "atom", source: pattern.slice(start, offset) }
      }
      const quantifier = pattern[offset]
      if (quantifier === "*" || quantifier === "+" || quantifier === "?" || quantifier === "{") {
        offset++
        let min = quantifier === "+" ? 1 : 0
        let max = quantifier === "?" ? 1 : Infinity
        if (quantifier === "{") {
          const end = pattern.indexOf("}", offset)
          const counts = pattern.slice(offset, end).split(",")
          min = Number(counts[0])
          max = counts.length === 1 ? min : counts[1] === "" ? Infinity : Number(counts[1])
          offset = end + 1
        }
        // Greediness affects captures, not whether a line contains a match.
        if (pattern[offset] === "?") offset++
        term = { kind: "repeat", term, min, max }
      }
      sequence.push(term)
    }
    alternatives.push({ kind: "sequence", terms: sequence })
    return { kind: "alternative", terms: alternatives }
  }
  const tree = parse(0)
  const states: Array<State> = [{ kind: "accept" }]
  const append = (state: State): number => {
    if (states.length >= 8192) throw new Error("patterns must not exceed 8192 compiled states")
    states.push(state)
    return states.length - 1
  }
  const build = (term: Term, next: number): number => {
    switch (term.kind) {
      case "atom":
        if (term.source === "^") return append({ kind: "start", next })
        if (term.source === "$") return append({ kind: "end", next })
        return append({
          kind: "atom",
          expression: new RegExp(term.source === "." ? "[^\\n]" : term.source, insensitive ? "iu" : "u"),
          next
        })
      case "sequence": {
        let head = next
        for (let index = term.terms.length - 1; index >= 0; index--) head = build(term.terms[index]!, head)
        return head
      }
      case "alternative":
        return append({ kind: "split", next: term.terms.map((child) => build(child, next)) })
      case "repeat": {
        let head = next
        if (term.max === Infinity) {
          const loop = append({ kind: "split", next: [] })
          states[loop] = { kind: "split", next: [next, build(term.term, loop)] }
          head = loop
        } else {
          for (let index = term.min; index < term.max; index++) {
            head = append({ kind: "split", next: [head, build(term.term, head)] })
          }
        }
        for (let index = 0; index < term.min; index++) head = build(term.term, head)
        return head
      }
    }
  }
  const start = build(tree, 0)
  return {
    *test(line) {
      let current: Array<number> = []
      let position = 0
      let work = 0
      const seen = new Int32Array(states.length)
      let generation = 0
      while (true) {
        generation++
        const pending = [...current, start]
        const consuming: Array<number> = []
        while (pending.length > 0) {
          if (++work === 4096) {
            work = 0
            yield
          }
          const id = pending.pop()!
          if (seen[id] === generation) continue
          seen[id] = generation
          const state = states[id]!
          switch (state.kind) {
            case "accept":
              return true
            case "atom":
              consuming.push(id)
              break
            case "split":
              for (const next of state.next) pending.push(next)
              break
            case "start":
              if (position === 0) pending.push(state.next)
              break
            case "end":
              if (position === line.length) pending.push(state.next)
              break
          }
        }
        if (position === line.length) return false
        const character = String.fromCodePoint(line.codePointAt(position)!)
        position += character.length
        current = []
        for (const id of consuming) {
          if (++work === 4096) {
            work = 0
            yield
          }
          const state = states[id]!
          if (state.kind === "atom" && state.expression.test(character)) current.push(state.next)
        }
      }
    }
  }
}
