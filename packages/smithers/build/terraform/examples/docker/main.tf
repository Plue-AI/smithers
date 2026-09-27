/*
 * A local remote cache, on one machine, with no cloud account.
 *
 *   terraform init
 *   terraform apply \
 *     -var 'postgres_password=...' \
 *     -var 'read_auth_token=...' \
 *     -var 'write_auth_token=...' \
 *     -var 'postgres_image=postgres@sha256:...' \
 *     -var 'bun_image=oven/bun@sha256:...'
 *
 * The endpoint output is what RemoteCacheStore.layer and RemoteArtifacts.layer
 * take as their `endpoint` option. A token goes in their `headers` option as
 * `Authorization: Bearer ...`; it is a capability, so it never appears in a
 * step key and never enters the journal. The read token may only read: every
 * PUT and DELETE presented on it is refused with 403.
 */

variable "postgres_password" {
  description = "Password for the cache role."
  type        = string
  sensitive   = true
}

variable "read_auth_token" {
  description = "Bearer token a reading client must present. It cannot publish."
  type        = string
  sensitive   = true
}

variable "read_namespace_prefix" {
  description = "Optional action-cache namespace allowed for the read token, such as pr-1/."
  type        = string
  default     = ""
}

variable "write_auth_token" {
  description = "Bearer token a publishing client must present."
  type        = string
  sensitive   = true
}

variable "postgres_image" {
  description = "Postgres image pinned as name@sha256:digest."
  type        = string
  default     = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
}

variable "bun_image" {
  description = "Bun image pinned as name@sha256:digest."
  type        = string
  default     = "oven/bun@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0"
}

variable "listen_port" {
  description = "Host port the cache is published on."
  type        = number
  default     = 8787
}

module "cache" {
  source = "../../modules/cache"

  name_prefix           = "smithers-build"
  postgres_password     = var.postgres_password
  postgres_image        = var.postgres_image
  bun_image             = var.bun_image
  read_auth_token       = var.read_auth_token
  read_namespace_prefix = var.read_namespace_prefix
  write_auth_token      = var.write_auth_token
  listen_port           = var.listen_port

  # Publish Postgres on the host only when inspecting it by hand.
  # postgres_port = 55432
}
