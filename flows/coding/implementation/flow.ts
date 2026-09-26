/** One planned Change becomes native JJ atoms, one agent edit at a time. */
import { Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Layer, Schema } from "effect"
// The flow below is this module's own default export. Discovery reads the
// literal `export default Flow.make(` without importing the file, so the flow
// cannot also be a named const; the registration beside it reads the value
// back through this self-import, which resolves after this module evaluates.
import { ApplyNative, atomError as Error, EditAtom, Entry, Observe, Prepare } from "../atoms.ts"
import { AtomicPlan, Change, CodingError, Implementation, Revision } from "../schema.ts"
import ImplementAtoms from "./flow.ts"

const Atom = Flow.make("coding/ImplementAtom", {
  payload: {
    change: Schema.NonEmptyString,
    atom: AtomicPlan,
    parent: Revision,
    ordinal: Schema.Number,
    memoryRevision: Schema.String
  },
  success: Schema.Struct({
    revision: Revision,
    reads: Schema.Array(Schema.String),
    writes: Schema.Array(Schema.String)
  }),
  error: Error,
  body: ({ change, atom, parent, ordinal, memoryRevision }) =>
    Entry.call({ change, atom, parent, ordinal }).pipe(
      Node.bindPlanned((operation) => ApplyNative.call({ operation })),
      Node.bindPlanned((result) => Observe.call({ result, parent, expectedChangeId: atom.changeId })),
      Node.bindPlanned((revision) =>
        EditAtom.call({ atom, parent, revision, memoryRevision }).pipe(
          Node.bindPlanned((report) =>
            Node.all({
              report: Node.succeed(report),
              final: Prepare.call({ change, phase: "snapshot", atom, revision, parent, ordinal, editing: report }).pipe(
                Node.bindPlanned((operation) => ApplyNative.call({ operation })),
                Node.bindPlanned((result) => Observe.call({ result, parent, expectedChangeId: revision.changeId })),
                Node.bindPlanned((snapshot) =>
                  Prepare.call({
                    change,
                    phase: "describe",
                    atom,
                    revision: snapshot,
                    parent,
                    ordinal,
                    editing: report
                  })
                ),
                Node.bindPlanned((operation) => ApplyNative.call({ operation })),
                Node.bindPlanned((result) => Observe.call({ result, parent, expectedChangeId: revision.changeId }))
              )
            }).pipe(Node.map(({ report, final }) => ({ revision: final, reads: report.reads, writes: report.writes })))
          )
        )
      )
    )
})

type AtomResult = typeof Atom.successSchema.Type
type AtomsNode = Node.Node<ReadonlyArray<AtomResult>, typeof Error.Type, Node.Services<ReturnType<typeof Atom.call>>>
const atoms = (
  change: typeof Change.Type,
  parent: Parameters<typeof Atom.call>[0]["parent"],
  memoryRevision: string,
  ordinal: number
): AtomsNode => {
  const atom = change.atoms[ordinal]
  return atom === undefined ?
    Node.succeed([]) :
    Atom.call({ change: change.id, atom, parent, memoryRevision, ordinal }).pipe(
      Node.bindPlanned((result) =>
        Node.all({ current: Node.succeed(result), rest: atoms(change, result.revision, memoryRevision, ordinal + 1) })
          .pipe(Node.map(({ current, rest }) => [current, ...rest]))
      )
    )
}

/**
 * One planned Change, implemented as its native atoms.
 *
 * An inlined caller can supply a planned parent, so the graph carries it
 * through and the mapper receives the resolved revision rather than a proxy.
 */
export default Flow.make("coding/ImplementAtoms", {
  description:
    "Implement one planned Change as native JJ atoms, preserving existing identities and recording exact revision evidence.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { change: Change, parent: Revision, memoryRevision: Schema.NonEmptyString },
  success: Implementation,
  error: Error,
  body: ({ change, parent, memoryRevision }) => {
    if (!Array.isArray(change.atoms)) {
      throw new CodingError({
        code: "invalid_plan",
        message: "An inline implementation needs a known atom list; materialize the Change before planning it"
      })
    }
    return Node.all({
      change: Node.succeed(change.id),
      parent: Node.succeed(parent),
      results: atoms(change, parent, memoryRevision, 0)
    }).pipe(Node.map(({ change, parent, results }) => ({
      change,
      parent,
      atoms: results.map((result) => result.revision),
      head: results.at(-1)!.revision,
      reads: [...new Set(results.flatMap((result) => result.reads))],
      writes: [...new Set(results.flatMap((result) => result.writes))]
    })))
  }
})

export const atomFlows = Layer.mergeAll(Interpreter.layer(Atom), Interpreter.layer(ImplementAtoms))
