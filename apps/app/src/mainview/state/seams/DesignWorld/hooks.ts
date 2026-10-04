/*
 * MOCK SEAM read hooks (delete with ./index.ts). Card files read the seeded
 * design world here and map rows to their View's props; Views never import
 * this. The first reader starts the simulated factory (no useEffect: the
 * start rides useSyncExternalStore's subscribe).
 */
import { useMemo, useSyncExternalStore } from "react"
import { useController } from "../../../ControllerContext"
import {
  branchOf, homeCounts, memberOf, openItems, stackItems, todoOf, traceOf,
  type ActorId, type DesignAct, type DesignAgent, type DesignBranch, type DesignDraft, type DesignFile, type DesignFlowVersion, type DesignForm,
  type DesignIssue, type DesignMember, type DesignPr, type DesignProposal, type DesignRepo, type DesignReview, type DesignRun, type DesignSecret,
  type DesignTerminal, type DesignTodo, type DesignTrace, type DesignWikiPage, type DesignWorld, type DesignWorldRows
} from "./index"

/** The controller's one DesignWorld instance; stub flows reach the same one as `actions.design`. */
export const useDesign = (): DesignWorld => useController().design

/** The whole world, re-read on every change. Prefer the narrower hooks below in card files. */
export const useDesignWorldOf = (design: DesignWorld): DesignWorldRows => {
  const version = useSyncExternalStore(design.subscribe, design.version, design.version)
  return useMemo(() => design.world(), [design, version])
}
export const useDesignWorld = (): DesignWorldRows => useDesignWorldOf(useDesign())

const useSelect = <T>(select: (world: DesignWorldRows) => T, deps: ReadonlyArray<unknown>): T => {
  const world = useDesignWorld()
  return useMemo(() => select(world), [world, ...deps])
}

export const useDesignRepo = (): DesignRepo => useSelect(world => world.repo, [])
/** Open stack items in merge order (Home). */
export const useDesignStack = (): ReadonlyArray<DesignTodo> => useSelect(openItems, [])
/** Every stack item in merge order, merged and dropped included. */
export const useDesignStackAll = (): ReadonlyArray<DesignTodo> => useSelect(stackItems, [])
export const useDesignCounts = (): ReturnType<typeof homeCounts> => useSelect(homeCounts, [])
export const useDesignTodo = (id: string): DesignTodo | undefined => useSelect(world => todoOf(world, id), [id])
export const useDesignTodoByRef = (ref: string): DesignTodo | undefined => useSelect(world => world.todos.find(each => each.ref === ref), [ref])
export const useDesignBranch = (id: string): DesignBranch | undefined => useSelect(world => branchOf(world, id), [id])
export const useDesignBranches = (): ReadonlyArray<DesignBranch> => useSelect(world => world.branches, [])
export const useDesignMembers = (): ReadonlyArray<DesignMember> => useSelect(world => world.members, [])
export const useDesignMember = (who: ActorId): DesignMember | undefined => useSelect(world => memberOf(world, who), [who])
export const useDesignFile = (branch: string, path: string): DesignFile | undefined =>
  useSelect(world => world.files.find(each => each.branch === branch && each.path === path), [branch, path])
export const useDesignIssue = (number: number): DesignIssue | undefined => useSelect(world => world.issues.find(each => each.number === number), [number])
export const useDesignWikiPage = (id: string): DesignWikiPage | undefined => useSelect(world => world.wiki.find(each => each.id === id), [id])
export const useDesignPr = (number: number): DesignPr | undefined => useSelect(world => world.prs.find(each => each.number === number), [number])
/** A TODO's latest attempt. */
export const useDesignTrace = (todo: string): DesignTrace | undefined => useSelect(world => traceOf(world, todo), [todo])
export const useDesignRuns = (): ReadonlyArray<DesignRun> => useSelect(world => world.runs, [])

/** The member this tab acts as (`?as=ben`), and their row. */
export const useDesignViewer = (): ActorId => useDesign().viewer()
export const useDesignMe = (): DesignMember | undefined => {
  const viewer = useDesignViewer()
  return useSelect(world => memberOf(world, viewer), [viewer])
}
export const useDesignTerminal = (id: string): DesignTerminal | undefined => useSelect(world => world.terminals.find(each => each.id === id), [id])
export const useDesignFileById = (id: string): DesignFile | undefined => useSelect(world => world.files.find(each => each.id === id), [id])
export const useDesignDraft = (id: string): DesignDraft | undefined => useSelect(world => world.drafts.find(each => each.id === id), [id])
export const useDesignFlowVersions = (flow: string): ReadonlyArray<DesignFlowVersion> =>
  useSelect(world => world.flowVersions.filter(each => each.flow === flow), [flow])
export const useDesignAgents = (): ReadonlyArray<DesignAgent> => useSelect(world => world.agents, [])
export const useDesignAgent = (id: string): DesignAgent | undefined => useSelect(world => world.agents.find(each => each.id === id), [id])
export const useDesignSecrets = (): ReadonlyArray<DesignSecret> => useSelect(world => world.secrets, [])
export const useDesignAct = (id: string): DesignAct | undefined => useSelect(world => world.acts.find(each => each.id === id), [id])
export const useDesignActs = (): ReadonlyArray<DesignAct> => useSelect(world => world.acts, [])
export const useDesignReview = (id: string): DesignReview | undefined => useSelect(world => world.reviews.find(each => each.id === id), [id])
export const useDesignProposal = (id: string): DesignProposal | undefined => useSelect(world => world.proposals.find(each => each.id === id), [id])
export const useDesignForm = (id: string): DesignForm | undefined => useSelect(world => world.forms.find(each => each.id === id), [id])
export const useDesignIssues = (): ReadonlyArray<DesignIssue> => useSelect(world => world.issues, [])
export const useDesignWiki = (): ReadonlyArray<DesignWikiPage> => useSelect(world => world.wiki, [])
export const useDesignSetup = (): DesignRepo["setup"] => useSelect(world => world.repo.setup, [])
export const useDesignTraceById = (id: string): DesignTrace | undefined => useSelect(world => world.traces.find(each => each.id === id), [id])
