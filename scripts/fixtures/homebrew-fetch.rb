# Hermetic unit seam: Homebrew DSL and signature process are unavailable in CI
# without release assets. This does not replace C-REL-02's actual brew/Cosign run.
require "fileutils"
class CurlDownloadStrategy
  def initialize(url, archive)
    @url, @archive = url, archive
  end
  def fetch(timeout: nil, **options)
    File.write(ENV.fetch("FETCH_MARKER"), "fetched")
  end
  def cached_location
    @archive
  end
  def system_command!(command, args:)
    if command == "/usr/bin/curl"
      source = args.last.end_with?(".json") ? ENV.fetch("SIGNATURE") : ENV.fetch("SUMS")
      FileUtils.cp(source, args[args.index("--output") + 1])
    else
      # Literal oracle: installer-releases.md / spec §16.1.1, never template-derived.
      raise "wrong issuer" unless args[args.index("--certificate-oidc-issuer") + 1] == "https://token.actions.githubusercontent.com"
      raise "wrong workflow/tag" unless args[args.index("--certificate-identity") + 1] == "https://github.com/smithersai/smithers/.github/workflows/release.yml@refs/tags/v1.2.3"
      raise "invalid signature" unless File.read(ENV.fetch("SIGNATURE")) == "valid"
    end
  end
end
class Formula
  def self.[](name)
    Object.new.tap { |v| def v.opt_bin; Pathname.new("/fake/cosign/bin"); end }
  end
  def self.method_missing(name, *args, **options, &block); end
end
require "pathname"
eval(File.read(ARGV.fetch(0)), TOPLEVEL_BINDING, ARGV.fetch(0))
if ARGV[1] == "source-install"
  class Formula
    def build
      Object.new.tap { |options| def options.bottle?; false; end }
    end
    def odie(message); raise message; end
  end
  Smithers.new.install
else
SmithersReleaseDownloadStrategy.new("https://github.com/smithersai/smithers/releases/download/v1.2.3/smithers-v1.2.3-darwin-arm64.tar.gz", ENV.fetch("ARCHIVE")).fetch
# Models the caller's extraction boundary, reached only after fetch verifies.
File.write(ENV.fetch("EXTRACT_MARKER"), "extracted")
end
