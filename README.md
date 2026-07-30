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

**Example session:**

```bash
$ curl -sL https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python -
Enter collection ID or URL: https://modrinth.com/collection/YyGKtxlz
Enter Minecraft version (e.g., "26.2"): 26.2
Enter loader (e.g., "fabric", "forge", "quilt") [default: fabric]:
Update existing mods? [Y/n] (default: Y):
Found 4 mod(s) in collection
Processing 1 required dependency(ies) for Litematica...
  [DEPENDENCY] DOWNLOADING: MaLiLib - malilib-....jar...
DOWNLOADING: Fresh Animations - FreshAnimations_....zip...
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
  -u, --update          Download and update existing mods. Default: true
  --no-update           Do not update existing mods
```

**Note:** All arguments except `-d` are optional. Missing values are prompted; loader defaults to fabric if you press Enter. Pass `-c`, `-v`, `-l`, and `-u`/`--no-update` for fully non-interactive runs.

## How It Works

- **Dependencies**: Automatically downloads required dependencies recursively. Marked with `[DEPENDENCY]` in logs.
- **Parallel Downloads**: Downloads up to 5 mods concurrently.
- **Updates**: Enabled by default. Skips mods already at latest version by comparing filenames.
- **File Format**: Saves as `filename.modid.ext` (e.g., `dynamic-fps-....LQ3K71Q1.jar`)

## Tests

```bash
python3 -m unittest test_main -v   # unit (offline)
python3 -m unittest test_e2e -v    # e2e (hits Modrinth)
```

## Requirements

- Python 3.6+
- No external dependencies (uses standard library only)

## Troubleshooting

- **"command not found: python"**: Use `python3` instead, or [install Python](https://www.python.org/downloads/).
- **"No version found"**: Mod doesn't support the specified version/loader. Check Modrinth for supported versions.
- **"Collection not found"**: Verify the collection ID/URL is correct and public.
- **Dependencies not downloading**: Only "required" dependencies are downloaded. Optional ones are skipped.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=aayushdutt/modrinth-collection-downloader&type=date&legend=top-left)](https://www.star-history.com/#aayushdutt/modrinth-collection-downloader&type=date&legend=top-left)
