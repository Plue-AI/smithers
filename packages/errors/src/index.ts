/**
 * Error types shared by the Smithers integration adapters.
 *
 * @since 1.0.0
 */

export {
  ERROR_REFERENCE_URL,
  getSmithersErrorDefinition,
  isSmithersErrorCode,
  type SmithersErrorCode,
  smithersErrorCodes,
  type SmithersErrorDefinition,
  smithersErrorDefinitions
} from "./ErrorCode.ts"
export { hasSmithersErrorShape, isSmithersError, SmithersError, type SmithersErrorOptions } from "./SmithersError.ts"
