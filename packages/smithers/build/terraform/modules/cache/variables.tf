variable "name_prefix" {
  description = "Prefix for every resource this module creates."
  type        = string
  default     = "smithers-build"

  validation {
    # The prefix becomes a container, network, and volume name, and one of
    # those names is interpolated into the Postgres healthcheck command.
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,48}$", var.name_prefix))
    error_message = "name_prefix must be 1-49 characters of letters, digits, underscores, dots, or dashes, starting with a letter or digit."
  }
}

variable "postgres_image" {
  description = "Postgres image pinned by immutable sha256 repository digest."
  type        = string
  default     = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"

  validation {
    condition     = can(regex("^\\S+@sha256:[0-9a-f]{64}$", var.postgres_image))
    error_message = "postgres_image must be an immutable image reference ending in @sha256:<64 lowercase hex characters>."
  }
}

variable "bun_image" {
  description = "Bun base image pinned by immutable sha256 repository digest."
  type        = string
  default     = "oven/bun@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0"

  validation {
    condition     = can(regex("^\\S+@sha256:[0-9a-f]{64}$", var.bun_image))
    error_message = "bun_image must be an immutable image reference ending in @sha256:<64 lowercase hex characters>."
  }
}

variable "postgres_user" {
  description = "Postgres role that owns the cache schema."
  type        = string
  default     = "smithers_build"

  validation {
    # The role name is interpolated into the container healthcheck command and
    # into the connection string, so it is restricted to an identifier.
    condition     = can(regex("^[a-zA-Z_][a-zA-Z0-9_]{0,62}$", var.postgres_user))
    error_message = "postgres_user must be a SQL identifier: a letter or underscore followed by letters, digits, or underscores."
  }
}

variable "postgres_database" {
  description = "Database holding the cache schema."
  type        = string
  default     = "smithers_build_cache"

  validation {
    condition     = can(regex("^[a-zA-Z_][a-zA-Z0-9_]{0,62}$", var.postgres_database))
    error_message = "postgres_database must be a SQL identifier: a letter or underscore followed by letters, digits, or underscores."
  }
}

variable "postgres_password" {
  description = "Password for the cache role. Supply it from a secret store, not from source."
  type        = string
  sensitive   = true

  validation {
    # Postgres trusts this password for every connection on the cache network,
    # and it is percent-encoded into DATABASE_URL, so only its emptiness and
    # its control characters are the module's business.
    condition     = length(var.postgres_password) >= 12 && !can(regex("[\\x00-\\x1f\\x7f]", var.postgres_password))
    error_message = "postgres_password must be at least 12 characters and must not contain control characters."
  }
}

variable "listen_port" {
  description = "Host port the remote-cache HTTP endpoint is published on."
  type        = number
  default     = 8787

  validation {
    condition     = floor(var.listen_port) == var.listen_port && var.listen_port >= 1 && var.listen_port <= 65535
    error_message = "listen_port must be an integer between 1 and 65535."
  }
}

variable "read_auth_token" {
  description = <<-EOT
    Bearer token a request must present to read the cache. Give it to every job
    that only consumes results, which is most of them: it cannot publish or
    delete. The Terraform deployment always requires authentication;
    empty-token development mode is available only when running the service
    directly on loopback.
  EOT
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.read_auth_token) >= 16 && length(var.read_auth_token) <= 4096 && can(regex("^[\\x21-\\x7e]+$", var.read_auth_token))
    error_message = "read_auth_token must be 16-4096 printable ASCII characters with no spaces."
  }
}

variable "read_namespace_prefix" {
  description = "Optional action-cache namespace the read token may access, such as pr-1/. A scoped token cannot read the unscoped artifact store."
  type        = string
  default     = ""

  validation {
    condition     = var.read_namespace_prefix == "" || can(regex("^[A-Za-z0-9_-]+/$", var.read_namespace_prefix))
    error_message = "read_namespace_prefix must be one namespace ending in /, or empty."
  }
}

variable "write_auth_token" {
  description = <<-EOT
    Bearer token a request must present to publish to or delete from the cache.
    Give it only to jobs trusted to write results every later job will trust: a
    single credential for both directions is the cache-poisoning path
    infra/CACHE-TRUST.md describes. It must differ from read_auth_token,
    because two equal values are one credential wearing two names.
  EOT
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.write_auth_token) >= 16 && length(var.write_auth_token) <= 4096 && can(regex("^[\\x21-\\x7e]+$", var.write_auth_token))
    error_message = "write_auth_token must be 16-4096 printable ASCII characters with no spaces."
  }

  validation {
    condition     = var.write_auth_token != var.read_auth_token
    error_message = "write_auth_token must differ from read_auth_token, or the split grants every reader write access."
  }
}

variable "max_body_bytes" {
  description = "Largest artifact the service accepts in one PUT."
  type        = number
  default     = 16777216

  validation {
    # The ceiling is the one config.js enforces: the service buffers an upload
    # to hash it, so the bound is also a memory bound.
    condition     = floor(var.max_body_bytes) == var.max_body_bytes && var.max_body_bytes >= 1 && var.max_body_bytes <= 16777216
    error_message = "max_body_bytes must be an integer between 1 and 16777216."
  }
}

variable "postgres_port" {
  description = "Host port Postgres is published on. Set to 0 to publish nothing."
  type        = number
  default     = 0

  validation {
    condition     = floor(var.postgres_port) == var.postgres_port && var.postgres_port >= 0 && var.postgres_port <= 65535
    error_message = "postgres_port must be 0 to publish nothing, or an integer between 1 and 65535."
  }
}
