/**
 * The include and exclude globs from a `.opencodereview/rule.json`, lower-cased.
 */
export type FileFilter = {
  include: Array<string>
  exclude: Array<string>
}
