/*
 * A self-hosted remote cache for the protocol `@smthrs/step-cache` and
 * `@smthrs/artifacts` already speak: `/ac/{keyDigest}` for entries and
 * `/cas/{digest}` for blobs, plus `POST /cas/findMissing`.
 *
 * Postgres does not speak HTTP, so this module runs two containers: Postgres,
 * which owns the tables in migrations/0001_initial.sql, and a small service in
 * service/, which is the protocol. Nothing here invents a second protocol; the
 * service is a translation of the existing one onto SQL.
 *
 * Replacing the Docker Postgres with a managed instance: delete
 * docker_container.postgres, docker_volume.postgres_data, and the initdb
 * mount; run the migration against the managed database with any SQL client;
 * and point local.database_url at the RDS or Cloud SQL endpoint. The service
 * container is unchanged, because its only coupling to Postgres is
 * DATABASE_URL.
 */

locals {
  postgres_host = "${var.name_prefix}-cache-postgres"
  service_name  = "${var.name_prefix}-cache-service"
  service_tag   = "${var.name_prefix}/cache-service:0.1.0"

  database_url = format(
    "postgres://%s:%s@%s:5432/%s?sslmode=disable",
    var.postgres_user,
    replace(urlencode(var.postgres_password), "+", "%20"),
    local.postgres_host,
    var.postgres_database
  )
}

resource "docker_network" "cache" {
  name = "${var.name_prefix}-cache"
}

resource "docker_volume" "postgres_data" {
  name = "${var.name_prefix}-cache-pgdata"
}

resource "docker_image" "postgres" {
  name         = var.postgres_image
  keep_locally = true
}

resource "docker_container" "postgres" {
  name        = local.postgres_host
  image       = docker_image.postgres.image_id
  hostname    = local.postgres_host
  restart     = "unless-stopped"
  memory      = 512
  memory_swap = 512

  env = [
    "POSTGRES_USER=${var.postgres_user}",
    "POSTGRES_PASSWORD=${var.postgres_password}",
    "POSTGRES_DB=${var.postgres_database}",
  ]

  networks_advanced {
    name = docker_network.cache.name
  }

  volumes {
    volume_name    = docker_volume.postgres_data.name
    container_path = "/var/lib/postgresql/data"
  }

  # Postgres runs everything in this directory on first initialization, which
  # is how the schema arrives. A managed instance applies the same file through
  # whatever migration path it already has.
  volumes {
    host_path      = abspath("${path.module}/migrations")
    container_path = "/docker-entrypoint-initdb.d"
    read_only      = true
  }

  dynamic "ports" {
    for_each = var.postgres_port > 0 ? [var.postgres_port] : []
    content {
      internal = 5432
      external = ports.value
      ip       = "127.0.0.1"
    }
  }

  healthcheck {
    test     = ["CMD-SHELL", "pg_isready -U ${var.postgres_user} -d ${var.postgres_database}"]
    interval = "5s"
    timeout  = "3s"
    retries  = 20
  }
}

resource "docker_image" "service" {
  name = local.service_tag

  build {
    context    = abspath("${path.module}/service")
    dockerfile = "Dockerfile"
    tag        = [local.service_tag]
    build_args = {
      BUN_IMAGE = var.bun_image
    }
  }

  # Rebuild when the shipped service source changes, and only then. The test
  # directory is not copied into the image, so it is not part of the trigger.
  triggers = {
    source = sha1(join("", [
      for file in fileset("${path.module}/service", "**") :
      filesha1("${path.module}/service/${file}")
      if !startswith(file, "test/")
    ]))
  }
}

resource "docker_container" "service" {
  name        = local.service_name
  image       = docker_image.service.image_id
  restart     = "unless-stopped"
  memory      = 256
  memory_swap = 256
  init        = true
  read_only   = true

  security_opts = ["no-new-privileges:true"]

  capabilities {
    drop = ["ALL"]
  }

  env = [
    "DATABASE_URL=${local.database_url}",
    "SMITHERS_CACHE_READ_TOKEN=${var.read_auth_token}",
    "SMITHERS_CACHE_READ_NAMESPACE_PREFIX=${var.read_namespace_prefix}",
    "SMITHERS_CACHE_WRITE_TOKEN=${var.write_auth_token}",
    "SMITHERS_CACHE_MAX_BODY_BYTES=${var.max_body_bytes}",
    "PORT=8080",
  ]

  networks_advanced {
    name = docker_network.cache.name
  }

  ports {
    internal = 8080
    external = var.listen_port
    ip       = "127.0.0.1"
  }

  # /healthz is the one route that needs no token, and it answers 200 only when
  # the service is serving. Reaching it is not enough: a 401 or a 503 is also a
  # response, so the status is what the check reads.
  healthcheck {
    test = [
      "CMD",
      "bun",
      "--eval",
      "if (!(await fetch('http://127.0.0.1:8080/healthz')).ok) process.exit(1)",
    ]
    interval = "10s"
    timeout  = "3s"
    retries  = 6
  }

  depends_on = [docker_container.postgres]
}
