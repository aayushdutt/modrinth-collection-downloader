# Modrinth Collection Downloader

> Download and update mods from Modrinth collections with automatic dependency resolution and parallel downloads.

[![Python](https://img.shields.io/badge/python-3.6+-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A fast, user-friendly Python script that downloads mods from Modrinth collections with intelligent dependency handling, parallel downloads, and an intuitive interactive interface.

## ✨ Features

- 🚀 **Parallel Downloads** - Download multiple mods simultaneously for faster processing
- 🔗 **Automatic Dependencies** - Automatically resolves and downloads required dependencies
- 💬 **Interactive Mode** - User-friendly prompts with sensible defaults
- 🔄 **Smart Updates** - Updates existing mods by default (configurable)
- 📊 **Detailed Statistics** - Comprehensive summary with separate tracking for mods and dependencies

> Also check out my new project [mctui](https://github.com/aayushdutt/mctui) - the TUI launcher for Minecraft. Minimal, fast launcher with mod management and other batteries built in.

## 🚀 Quick Start

### In your browser

The web UI in [`web/`](web/) does the same thing without Python. Paste a collection link, pick a version and loader, then:

- **Download zip** (any browser): every file, laid out as `mods/`, `resourcepacks/` and `shaderpacks/`.
- **Install into folder** (Chrome, Edge): writes straight into your game folder, replaces older versions, and recognises mods you installed by hand so you don't end up with duplicates.

It runs entirely in the browser against the Modrinth API, and every file is checked against Modrinth's SHA-512. Links are shareable: `?c=YyGKtxlz&v=26.2&l=fabric` reopens that exact setup.

To run it locally: `cd web && pnpm install && pnpm dev`. To deploy on Vercel, import the repo and set the project's Root Directory to `web`.

### Interactive oneliner

The easiest way to use the script - just run it and follow the prompts:

```bash
# Using curl (replace python with python3 for mac)
curl -sL https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python -

# Or using wget (replace python with python3 for mac)
wget -qO- https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python -
```

You'll be prompted for:

- Collection ID or URL
- Minecraft version
- Loader (defaults to fabric)
- Update preference (defaults to Yes)
- Alpha fallback when no release or beta exists (defaults to No; betas are always allowed as a fallback. Use `--allow-prerelease` or `--channel` to skip)

**Example session:**

```bash
$ curl -sL https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python -
Enter collection ID or URL: https://modrinth.com/collection/YyGKtxlz
Enter Minecraft version (e.g., "26.2"): 26.2
Enter loader (e.g., "fabric", "forge", "quilt") [default: fabric]:
Update existing mods? [Y/n] (default: Y):
Allow alpha builds when no release or beta is available? [y/N]: y
Found 4 mod(s) in collection
Version channel policy: alpha
PREPARING: MaLiLib (...) - ...
PREPARING: Litematica (...) - ...
PREPARING: Fresh Animations (...) - ...
DOWNLOADED: ...
...
```

### Local Installation

Download or copy `main.py` and run it:

```bash
# Download the script (or copy from repository)
curl -sL https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py -o main.py

# Run interactively
python main.py

# Or with arguments (fully non-interactive)
python main.py -c YyGKtxlz -v 26.2 -l fabric -u

# Also allow alpha builds when a project has no release or beta
python main.py -c YyGKtxlz -v 26.2 -l fabric -u --allow-prerelease

# Releases only, never betas
python main.py -c YyGKtxlz -v 26.2 -l fabric -u --channel release
```

## 📋 Command-Line Options

```
options:
  -h, --help            show this help message and exit
  -c, --collection COLLECTION
                        ID or URL of the collection to download
                        (e.g., YyGKtxlz or https://modrinth.com/collection/YyGKtxlz)
  -v, --version VERSION
                        Minecraft version (e.g., "26.2")
  -l, --loader LOADER   Loader to use (e.g., "fabric", "forge", "quilt"). Default: "fabric"
  -d, --directory DIRECTORY
                        Directory to download mods to. Default: "./mods"
  --resourcepacks-directory DIRECTORY
                        Resource-pack destination. Default: sibling resourcepacks/ directory
  -u, --update          Download and update existing mods. Default: true
  --no-update           Do not update existing mods
  --channel {release,beta,alpha}
                        Allowed version channels. Default: beta (a release
                        when one exists, otherwise a beta). alpha also allows
                        alphas; release allows releases only.
  --allow-prerelease    Also allow alphas when no release or beta exists (same as --channel alpha)
```

**Note:** All arguments are optional. Missing collection, version, loader, or update values are prompted; loader defaults to fabric if you press Enter. Interactive runs also ask about alpha fallback, including the piped oneliner. Pass `-c`, `-v`, `-l`, and `-u`/`--no-update` for fully non-interactive runs, which default to `--channel beta`. `--channel` and `--allow-prerelease` are mutually exclusive and skip the alpha question.

Collection and Minecraft version have no defaults: blank answers repeat those prompts, and closing input exits with an error. Enter accepts the defaults for loader, update preference, and alpha fallback. Explicitly empty `-c`, `-v`, or `-l` arguments are rejected before prompting.

## How It Works

- **Metadata planning**: Looks up independent project/version metadata with up to five network workers. Shared project and exact-version requests are reused across dependency graph passes. The coordinator selects versions, checks dependency constraints, and reports progress before installation starts.
- **Planning progress**: Before downloads start, shows collection project counts, metadata lookups, required-version lookups, and installed-file checks. Progress is flushed immediately, including when output is piped. Network retries are announced, and the finished plan reports elapsed time and any resolution errors.
- **Dependencies**: Resolves required dependencies before installation, including exact `version_id` pins and references with only a version ID. A shared dependency is downloaded once per run. Conflicting pins or unavailable required dependencies fail their connected group of projects; parent files are not installed. Cyclic required dependencies fail explicitly.
- **Parallel Downloads**: Downloads up to 5 mods concurrently.
- **Updates**: Enabled by default. Verifies installed files before skipping or replacing them. Downloads go to temporary files, are checked against available size/hash metadata, and replace the destination atomically; failed downloads preserve the previous installation. Recognized older files and misplaced resource-pack duplicates are removed after a successful replacement. Unrecognized local files are preserved.
- **Installation transactions**: Projects linked by required dependencies are staged as one group before any installed files change. Verified installed versions also link projects in that group, so a failed parent update preserves its previous dependencies. A staging failure preserves the whole group's current files. A filesystem failure during installation rolls the group back; unrelated groups can still finish. Persistent disk errors can prevent full rollback; the error prints a retained `modrinth-recovery-*` directory containing originals and an `originals/original-paths.json` recovery map (or a retained staging directory if recovery creation fails). Keep those backups and restore affected files before retrying.
- **No updates**: `--no-update` keeps installed project versions and resolves their own requirements. If the installed version cannot be identified and verified from Modrinth metadata, the project fails rather than borrowing dependencies from a newer version.
- **Version channels**: A release is always preferred, even when a newer beta or alpha exists. When a project has no release for your version, a beta is used instead (`--channel beta`, the default); alphas are only used with `--channel alpha` or `--allow-prerelease`. Use `--channel release` for releases only. Exact dependency pins must also satisfy this channel policy and the requested Minecraft version/loader.
- **File Format**: Saves as `filename.modid.ext` (e.g., `dynamic-fps-....LQ3K71Q1.jar`). Collection resource packs go to the sibling `resourcepacks/` directory unless overridden, including packs also required by another collection project. Other dependencies go to `mods/`.
- **Failures**: Returns a nonzero process exit status when the collection cannot be read or a project cannot be resolved, verified, or installed. Unrelated valid projects may still finish. Network requests use timeouts and bounded retries for transient failures.

## Tests

The suite lives in `tests/`. Offline tests use a local HTTP server and temporary directories to test real CLI processes, dependency resolution, safe updates, failed downloads, and exit statuses. They require Python 3.9+; CI runs them on Python 3.9 and 3.13. No external packages or live Modrinth access are needed.

```bash
python3 -m unittest discover -s tests -t . -v
# Run only the HTTP/CLI integration tests
python3 -m unittest tests.test_cli -v
```

Live tests are opt-in because the public collection and API can change. They download actual artifacts into temporary directories and bound each downloader subprocess to 180 seconds:

```bash
MCD_LIVE_TESTS=1 python3 -m unittest tests.test_e2e -v
```

## Requirements

- Python 3.6+
- No external dependencies (uses standard library only)

## Troubleshooting

- **"command not found: python"**: Use `python3` instead, or [install Python](https://www.python.org/downloads/).
- **"No version found"**: Mod doesn't support the specified version/loader. Check Modrinth for supported versions.
- **"Collection not found"**: Verify the collection ID/URL is correct and public.
- **Dependencies not downloading**: Only "required" dependencies are downloaded. Optional ones are skipped. An unavailable or conflicting required dependency blocks its parent; read the failure summary before retrying.
- **Download verification failed**: The destination is left unchanged. Retry after checking your connection and the upstream artifact.
- **Installed version cannot be identified**: `--no-update` needs verified metadata for the installed version. Back up unfamiliar files before removing them or enabling updates.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=aayushdutt/modrinth-collection-downloader&type=date&legend=top-left)](https://www.star-history.com/#aayushdutt/modrinth-collection-downloader&type=date&legend=top-left)
