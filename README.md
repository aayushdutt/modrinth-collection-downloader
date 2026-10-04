# Modrinth Collection Downloader

> Download and update mods and packs from Modrinth collections with automatic dependency resolution and parallel downloads.

[**Open the web app**](https://modrinth-collection-downloader.vercel.app/) · [**Use the Python CLI**](#interactive-oneliner)

[![Python](https://img.shields.io/badge/python-3.6+-blue.svg)](https://www.python.org/downloads/)

Use the hosted web app without installing anything, or run the standalone Python script from your terminal. Both resolve required dependencies, prefer stable releases, and download files in parallel.

## ✨ Features

- 🚀 **Parallel Downloads** - Download multiple mods simultaneously for faster processing
- 🔗 **Automatic Dependencies** - Automatically resolves and downloads required dependencies
- 🌐 **Browser App** - Download a zip or install into a game folder, with shareable collection/version/loader links
- 💬 **Interactive CLI** - User-friendly prompts with sensible defaults, or command-line arguments for automation
- 🔄 **Smart Updates** - Replaces recognized older files; the CLI also supports keeping installed versions with `--no-update`
- 📊 **Detailed Statistics** - Comprehensive summary with separate tracking for mods and dependencies

> Also check out my new project [mctui](https://github.com/aayushdutt/mctui) - the TUI launcher for Minecraft. Minimal, fast launcher with mod management and other batteries built in.

## 🚀 Quick Start

### In your browser

Open [modrinth-collection-downloader.vercel.app](https://modrinth-collection-downloader.vercel.app/). Paste a **public** Modrinth collection link or ID, choose a Minecraft version and loader, and review the files and dependency warnings before downloading. The app suggests a target based on the collection's supported versions and loaders.

- **Download zip** (modern browsers): selected compatible files, laid out as `mods/`, `resourcepacks/` and `shaderpacks/`. Extract the archive and copy each folder's files into the matching folder in your game instance. Remove older copies of those mods first.
- **Install into folder** (desktop Chrome or Edge when folder access is available): choose your game instance folder, the one containing `mods/`. The app writes files into their matching folders and replaces recognized older versions. It can identify hand-installed `.jar` and `.zip` files through Modrinth's hash lookup. A `mods/` folder can also be selected directly when all files are mods.

The app runs entirely in your browser and fetches metadata and downloads directly from Modrinth. Downloads are checked against Modrinth's SHA-512 when provided. Mods, resource packs, and shaders are supported; modpacks need a launcher. Minecraft and the mod loader must already be installed.

Releases are preferred, with betas as a fallback. Check **Use alphas when there's no release or beta** to allow alpha builds too. Click **Share** to copy the current collection, Minecraft version, loader, and alpha setting; individual skipped files are not included. For example: [open the sample setup](https://modrinth-collection-downloader.vercel.app/?c=YyGKtxlz&v=26.2&l=fabric). Add `&pre=1` to allow alphas. If a shared target is unsupported by the collection, the app selects a supported target instead.

On macOS, the folder picker may block `~/Library`, where the default launcher stores Minecraft; use the zip for that location. Folder installs download and verify all files before committing each dependency group. A failed download leaves its group unchanged; a write failure or Stop during a commit rolls that group back. Independent groups that already completed remain installed.

The installer backs up affected files in a temporary `.modrinth-backup-*` directory inside the selected folder. Successful installs and rollbacks remove that backup. If a disk error prevents full rollback, the app shows the retained backup's location; restore its files using `original-paths.json` before retrying. The map records each affected path relative to the selected folder; a `null` value marks a newly created file to remove during recovery. Installed-file identification errors stop installation before files change.

For local development and Vercel configuration, see [Web Development and Deployment](#web-development-and-deployment).

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

## How the CLI Works

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

## Web Development and Deployment

The web app lives in [`web/`](web/) and uses React, TypeScript, Vite, and Tailwind CSS. Use Node.js 24 (also used in CI) and the pnpm version pinned in [`web/package.json`](web/package.json), currently `10.33.2`.

```bash
cd web
pnpm install --frozen-lockfile
pnpm dev
```

To create and preview the production build:

```bash
pnpm build
pnpm preview
```

The build output is `web/dist/`. No backend or environment variables are required.

To deploy your own copy on Vercel, import the repository and set:

| Setting | Value |
| --- | --- |
| Root Directory | `web` |
| Framework Preset | Vite |
| Install Command | `pnpm install --frozen-lockfile` |
| Build Command | `pnpm build` |
| Output Directory | `dist` |

[`web/vercel.json`](web/vercel.json) sets immutable caching for the generated assets.

## Tests

Web checks run offline with mocked downloads, an in-memory folder API, and DOM integration tests for install controls:

```bash
cd web
pnpm test
pnpm lint
pnpm build
```

The Python suite lives in `tests/`; run it from the repository root. Offline tests use a local HTTP server and temporary directories to test real CLI processes, dependency resolution, safe updates, failed downloads, and exit statuses. They require Python 3.9+; CI runs them on Python 3.9 and 3.13. No external packages or live Modrinth access are needed. CI also runs the web tests, lint, and production build on Node.js 24.

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

- **Hosted web app**: a modern browser; direct folder installation requires browser support for the File System Access API.
- **Python CLI**: Python 3.6+, with no external dependencies (standard library only).
- **Web development**: Node.js and pnpm as described above.

## Troubleshooting

- **"command not found: python"**: Use `python3` instead, or [install Python](https://www.python.org/downloads/).
- **"No version found"**: Mod doesn't support the specified version/loader. Check Modrinth for supported versions.
- **"Collection not found"**: Verify the collection ID/URL is correct and public.
- **"Install into folder" is missing**: Use desktop Chrome or Edge with folder access support, or download a zip.
- **Modpacks in a collection**: The web app leaves these out; install them through your launcher.
- **Dependencies not downloading**: Only "required" dependencies are downloaded. Optional ones are skipped. An unavailable or conflicting required dependency blocks its parent; read the failure summary before retrying.
- **Download verification failed**: That dependency group's files are left unchanged. Retry after checking your connection and the upstream artifact. Independent groups that already completed remain installed.
- **Installed version cannot be identified**: `--no-update` needs verified metadata for the installed version. Back up unfamiliar files before removing them or enabling updates.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=aayushdutt/modrinth-collection-downloader&type=date&legend=top-left)](https://www.star-history.com/#aayushdutt/modrinth-collection-downloader&type=date&legend=top-left)
