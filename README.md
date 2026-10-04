# Modrinth Collection Downloader

Download and update public Modrinth collections from your browser or terminal.

[**Open the web app**](https://modrinth-collection-downloader.vercel.app/)

## Features

- Resolves required dependencies and downloads files in parallel.
- Verifies downloads and safely replaces recognized older files.
- Prefers releases, falls back to betas, and allows alphas when enabled.
- Offers browser zip downloads, direct folder installation, and an interactive Python CLI.

## Quick start

### Browser

Open the web app, paste a public collection link or ID, and choose your Minecraft version and loader.

- **Download zip**: Extract it into your game instance's matching folders. Remove older copies of those mods first.
- **Install into folder**: In desktop Chrome or Edge, choose the game instance folder containing `mods/` to update it directly.
- **Share**: Copy the collection, Minecraft version, loader, and alpha setting. Skipped files aren't included.

The app runs entirely in your browser and downloads directly from Modrinth. It supports mods, resource packs, and shaders; Minecraft and the loader must already be installed. Install modpacks through your launcher.

If folder access is unavailable or blocked (including `~/Library` on macOS), use a zip.

### Python CLI

Requires **Python 3.6+**, with no external dependencies. Run interactively:

```bash
curl -fsSL https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python3 -
```

Or run `main.py` from a repository checkout with arguments:

```bash
python3 main.py -c YyGKtxlz -v 26.2 -l fabric -u
```

Mods go to `./mods`; collection resource packs go to the sibling `resourcepacks/` directory. Use `--help` for options.

### CLI options

| Option | Purpose |
| --- | --- |
| `-c`, `--collection` | Public collection ID or URL |
| `-v`, `--version` | Minecraft version |
| `-l`, `--loader` | Mod loader; defaults to `fabric` |
| `-d`, `--directory` | Mods destination; defaults to `./mods` |
| `--resourcepacks-directory` | Override the resource-pack destination |
| `-u`, `--update` | Update existing mods; enabled by default |
| `--no-update` | Keep verified installed versions and their requirements |
| `--channel` | `release`, `beta` (default), or `alpha` |
| `--allow-prerelease` | Allow alpha fallback; equivalent to `--channel alpha` |

Missing values are prompted. Pass `-c`, `-v`, `-l`, and `-u` or `--no-update` for a non-interactive run. `--channel` and `--allow-prerelease` are mutually exclusive.

## Updates and recovery

Required dependencies are resolved before installation. Conflicting or unavailable dependencies block their group; independent groups can still finish.

Folder installs stage and verify files before updating a dependency group. Failed downloads leave it unchanged; write failures or Stop during a commit trigger rollback. Only recognized older files are removed.

If rollback cannot finish, keep the reported backup and restore files using `original-paths.json` before retrying. A `null` entry marks a newly created file to remove.

If a collection can't be opened, check that it's public. If no compatible files are found, check the Minecraft version and loader or enable alpha fallback.

## Development

The web app uses React, TypeScript, Vite, and Tailwind CSS. Use Node.js 24 and the pnpm version pinned in [`web/package.json`](web/package.json).

```bash
cd web
pnpm install --frozen-lockfile
pnpm dev
```

For Vercel, set **Root Directory** to `web`, **Framework Preset** to Vite, **Build Command** to `pnpm build`, and **Output Directory** to `dist`. No backend or environment variables are needed.

### Checks

From `web/`:

```bash
pnpm test
pnpm lint
pnpm build
```

Python tests require Python 3.9+. From the repository root:

```bash
python3 -m unittest discover -s tests -t . -v
```

Offline tests need no live Modrinth access. To run live download tests, use `MCD_LIVE_TESTS=1 python3 -m unittest tests.test_e2e -v`.

## Related

[mctui](https://github.com/aayushdutt/mctui) — a terminal Minecraft launcher with mod management.

[Star history](https://www.star-history.com/#aayushdutt/modrinth-collection-downloader&type=date&legend=top-left)
