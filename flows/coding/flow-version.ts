/** A flow version uses the same execution identity that the host plans. */
import * as Digest from "@smthrs/core/Digest"
import * as Descriptor from "@smthrs/registry/Descriptor"

export const bindFlowDependencies = (descriptor: Descriptor.FlowDescriptor, lockfileDigest?: string) =>
  lockfileDigest === undefined || lockfileDigest === Digest.digest(new TextEncoder().encode("[]"))
    ? descriptor
    : new Descriptor.FlowDescriptor({ ...descriptor,
      frontmatter: { ...descriptor.frontmatter, repositoryLockfileDigest: lockfileDigest } })
