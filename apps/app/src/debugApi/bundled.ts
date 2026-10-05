import type { OpenApiDocument } from "../mainview/state/seams/DebugApiSeam"
export const bundledOpenApi = async (): Promise<OpenApiDocument> => (await import("virtual:smithers-openapi")).default
