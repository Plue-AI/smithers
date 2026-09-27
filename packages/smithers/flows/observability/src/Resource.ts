/**
 * Explicit, validated OpenTelemetry resource metadata for Smithers.
 *
 * @since 0.1.0
 */

import * as OtelResource from "@effect/opentelemetry/Resource"
import type { Attributes as OtelAttributes } from "@opentelemetry/api"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"
import { schemaIssueMessage, schemaIssuePath } from "./internal/schemaIssuePath.ts"

/**
 * Largest service-name or service-version field accepted by a resource.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumIdentityLength = 1_024

/**
 * Largest attribute key accepted by a resource.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumAttributeKeyLength = 1_024

/**
 * Largest string value accepted by one resource attribute.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumAttributeStringLength = 65_536

/**
 * Largest number of elements accepted in one array attribute value.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumAttributeArrayLength = 256

/**
 * Largest number of attributes accepted by one resource.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumAttributes = 256

/**
 * Largest OTLP/JSON encoding accepted for one whole resource, in UTF-8 bytes.
 *
 * The measure is the OTLP `Resource` message the exporters place in every
 * request, `{"attributes":[{"key":…,"value":{…}}],"droppedAttributesCount":0}`
 * with service identity and SDK-added `telemetry.sdk.name` and
 * `telemetry.sdk.language` included, after JSON escaping and UTF-8 encoding.
 * These SDK fields are conservatively reserved even for the default Effect
 * exporter. Caller attributes overwritten by SDK identity or metadata are
 * still counted. It is the bound the per-field limits cannot express: 256
 * attributes at the string ceiling would encode to 16 MiB, and the resource
 * rides in every export request, so the default transport, which discards a
 * request over 1 MiB, would deliver nothing at all. 128 KiB admits one
 * ASCII attribute at the string ceiling and leaves that transport 888 KiB of every
 * request for the signal batch; see `Otlp.reservedBatchBytes`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumResourceBytes = 131_072

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const embeddedNul = new RegExp(String.fromCharCode(0))

const isWellFormed = (value: string): boolean => !loneSurrogate.test(value) && !embeddedNul.test(value)

const identity = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumIdentityLength),
  Schema.makeFilter((value: string) => isWellFormed(value), { title: "wellFormedResourceIdentity" })
)

const attributeString = Schema.String.check(
  Schema.isMaxLength(maximumAttributeStringLength),
  Schema.makeFilter((value: string) => isWellFormed(value), { title: "wellFormedAttributeString" })
)

const attributeNumber = Schema.Number.check(
  Schema.makeFilter((value: number) => Number.isFinite(value), { title: "finiteAttributeNumber" })
)

/**
 * Runtime schema for one OpenTelemetry resource attribute value.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const AttributeValue = Schema.Union([
  attributeString,
  attributeNumber,
  Schema.Boolean,
  Schema.Array(attributeString),
  Schema.Array(attributeNumber),
  Schema.Array(Schema.Boolean)
]).check(
  Schema.makeFilter(
    (value) =>
      !Array.isArray(value) || value.length <= maximumAttributeArrayLength || {
        path: [],
        issue: `holds ${value.length} elements, over the ${maximumAttributeArrayLength} element limit`
      },
    { title: "boundedResourceAttributeArrays" }
  )
)

/**
 * Runtime schema for OpenTelemetry resource attributes.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Attributes = Schema.Record(Schema.String, AttributeValue).check(
  Schema.makeFilter(
    (attributes: Readonly<Record<string, unknown>>) => Object.keys(attributes).length <= maximumAttributes,
    { title: "boundedResourceAttributes" }
  ),
  Schema.makeFilter(
    (attributes: Readonly<Record<string, unknown>>) =>
      Object.keys(attributes).every(
        (key) => key.length > 0 && key.length <= maximumAttributeKeyLength && isWellFormed(key)
      ),
    { title: "wellFormedResourceAttributeKeys" }
  )
)

const encoder = new TextEncoder()

/**
 * Counts OTLP JSON fragments, including keys, wrappers, escaping and UTF-8.
 * Stops at the first fragment over budget: the refusal reports a lower bound.
 * A configuration may reuse one large string in thousands of array slots, so
 * serializing the whole resource before checking could allocate gigabytes.
 */
const encodedResourceBytes = (configuration: {
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  readonly attributes?: Record<string, unknown> | undefined
}): number => {
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength
  const identityAttributes = OtelResource.configToAttributes({
    serviceName: configuration.serviceName,
    ...(configuration.serviceVersion === undefined ? {} : { serviceVersion: configuration.serviceVersion })
  })
  // Use the pinned SDK projection so its added metadata cannot escape the
  // complete-resource ceiling. Both exporters use these OTLP AnyValue shapes.
  let total = bytes({
    attributes: OtlpResource.entriesToAttributes(Object.entries(identityAttributes)),
    droppedAttributesCount: 0
  })
  for (const [key, value] of Object.entries(configuration.attributes ?? {})) {
    // An identity attribute is always present, so every addition needs a comma.
    total += 1 + bytes({ key, value: Array.isArray(value) ? { arrayValue: { values: [] } } : null })
    if (Array.isArray(value)) {
      for (const [index, element] of value.entries()) {
        total += (index === 0 ? 0 : 1) + bytes(OtlpResource.unknownToAttributeValue(element))
        if (total > maximumResourceBytes) return total
      }
    } else {
      total += bytes(OtlpResource.unknownToAttributeValue(value)) - 4 // replace JSON null
    }
    if (total > maximumResourceBytes) return total
  }
  return total
}

/**
 * Runtime schema for the service identity attached to exported telemetry.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Configuration = Schema.Struct({
  serviceName: identity,
  serviceVersion: Schema.optional(identity),
  attributes: Schema.optional(Attributes)
}).check(
  Schema.makeFilter(
    (configuration: {
      readonly serviceName: string
      readonly serviceVersion?: string | undefined
      readonly attributes?: Record<string, unknown> | undefined
    }) => {
      const bytes = encodedResourceBytes(configuration)
      // Only attributes can carry a resource past the budget: the two identity
      // fields encode to at most 6 KiB each, so the refusal points there.
      return bytes <= maximumResourceBytes || {
        path: ["attributes"],
        issue: `bring the resource to at least ${bytes} bytes of OTLP JSON, over the ${maximumResourceBytes} byte limit`
      }
    },
    { title: "boundedResourceBytes" }
  )
)

/**
 * Configuration used to identify the service emitting telemetry.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Configuration = typeof Configuration.Type

/**
 * Stable resource-configuration refusal shared by every OTEL layer.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class InvalidResourceConfiguration extends Schema.TaggedError<InvalidResourceConfiguration>()(
  "@smthrs/observability/InvalidResourceConfiguration",
  {
    code: Schema.Literal("invalid_resource_configuration"),
    path: Schema.String,
    message: Schema.String
  }
) {}

const invalid = (cause: unknown): InvalidResourceConfiguration => {
  const path = schemaIssuePath(cause, "resource")
  return new InvalidResourceConfiguration({
    code: "invalid_resource_configuration",
    path,
    message: `OpenTelemetry resource ${path} ${schemaIssueMessage(cause) ?? "is invalid"}`
  })
}

/**
 * Decodes one resource configuration without retaining rejected values.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export const decode = (
  configuration: unknown
): Effect.Effect<Configuration, InvalidResourceConfiguration> =>
  Schema.decodeUnknownEffect(Configuration)(configuration).pipe(Effect.mapError(invalid))

/**
 * Decodes one resource configuration for the package's pure projection API.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export const decodeSync = (configuration: unknown): Configuration => {
  try {
    return Schema.decodeUnknownSync(Configuration)(configuration)
  } catch (cause) {
    throw invalid(cause)
  }
}

/**
 * Projects a decoded resource into the exact optional-property shape expected
 * by the OpenTelemetry SDK.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const toOpenTelemetryConfiguration = (
  configuration: Configuration
): {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly attributes?: OtelAttributes
} => ({
  serviceName: configuration.serviceName,
  ...(configuration.serviceVersion === undefined ? {} : { serviceVersion: configuration.serviceVersion }),
  ...(configuration.attributes === undefined
    ? {}
    : {
      attributes: Object.fromEntries(
        Object.entries(configuration.attributes).map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value] : value
        ])
      ) as OtelAttributes
    })
})

/**
 * Converts explicit service metadata into OpenTelemetry resource attributes.
 *
 * No environment variables are read. Invalid metadata throws the same typed
 * {@link InvalidResourceConfiguration} every layer returns during acquisition.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const configToAttributes = (configuration: Configuration): OtelAttributes =>
  OtelResource.configToAttributes(toOpenTelemetryConfiguration(decodeSync(configuration)))

/**
 * Provides an explicitly validated OpenTelemetry resource.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (
  configuration: Configuration
): Layer.Layer<OtelResource.Resource, InvalidResourceConfiguration> =>
  Layer.unwrap(
    Effect.map(decode(configuration), (decoded) => OtelResource.layer(toOpenTelemetryConfiguration(decoded)))
  )

/**
 * The OpenTelemetry resource service.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export const Resource = OtelResource.Resource
