/**
 * Native repository selection and access contracts.
 *
 * @since 1.0.0
 */

/**
 * Shared repository access values used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const REPOSITORY_ACCESS_VALUES = ["read", "read-write"] as const
/**
 * The repository access contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type RepositoryAccess = (typeof REPOSITORY_ACCESS_VALUES)[number]

/**
 * The local repository inspection contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LocalRepositoryInspection {
  readonly root: string
  readonly name: string
  readonly head: string | null
  readonly branch: string | null
  readonly remoteUrl: string | null
}

/**
 * A repository selected by the native host. The capability is deliberately
 * absent from persisted connector rows and is consumed once by
 * `POST /api/repo/open`.
 * @since 1.0.0
 * @category models
 */
export interface AuthorizedLocalRepositoryInspection extends LocalRepositoryInspection {
  readonly authorizationId: string
}

/**
 * The local repository selection error contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type LocalRepositorySelectionError = {
  readonly status: "error"
  readonly code:
    | "native-required"
    | "not-a-directory"
    | "not-a-repository"
    | "permission-denied"
    | "inspection-failed"
  readonly message: string
}

/**
 * The inspect local repository result contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type InspectLocalRepositoryResult =
  | { readonly status: "connected"; readonly repository: LocalRepositoryInspection }
  | LocalRepositorySelectionError

/**
 * The pick local repository result contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type PickLocalRepositoryResult =
  | { readonly status: "connected"; readonly repository: AuthorizedLocalRepositoryInspection }
  | { readonly status: "cancelled" }
  | LocalRepositorySelectionError
