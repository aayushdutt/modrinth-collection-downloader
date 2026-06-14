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
- Loader (fabric, forge, quilt, etc.)
- Update preference (defaults to Yes)

**Example session:**

```bash
$ curl -sL https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python -
Enter collection ID or URL: https://modrinth.com/collection/5OBQuutT
Enter Minecraft version (e.g., "1.21.9"): 1.21.9
Enter loader (e.g., "fabric", "forge", "quilt"): fabric
Update existing mods? [Y/n] (default: Y):
Found 22 mod(s) in collection
Processing 2 required dependency(ies) for Dynamic FPS...
  [DEPENDENCY] DOWNLOADING: Fabric API - fabric-api-0.134.0+1.21.9.jar...
DOWNLOADING: Dynamic FPS - dynamic-fps-3.10.1+minecraft-1.21.9-fabric.jar...
...
```

### Local Installation

Download or copy `main.py` and run it:

```bash
# Download the script (or copy from repository)
curl -sL https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py -o main.py

# Run interactively
python main.py

# Or with arguments
python main.py -c 5OBQuutT -v 1.21.9 -l fabric
```

## 📋 Command-Line Options

```
options:
  -h, --help            show this help message and exit
  -c, --collection COLLECTION
                        ID or URL of the collection to download
                        (e.g., 5OBQuutT or https://modrinth.com/collection/5OBQuutT)
  -v, --version VERSION
                        Minecraft version (e.g., "1.20.4", "1.21")
  -l, --loader LOADER   Loader to use (e.g., "fabric", "forge", "quilt")
  -d, --directory DIRECTORY
                        Directory to download mods to. Default: "./mods"
  -u, --update          Download and update existing mods. Default: true
  --no-update           Do not update existing mods
```

**Note:** All arguments except `-d` are optional. The script will prompt for any missing values.

## How It Works

- **Dependencies**: Automatically downloads required dependencies recursively. Marked with `[DEPENDENCY]` in logs.
- **Parallel Downloads**: Downloads up to 5 mods concurrently.
- **Updates**: Enabled by default. Skips mods already at latest version by comparing filenames.
- **File Format**: Saves as `filename.modid.ext` (e.g., `dynamic-fps-3.10.1+minecraft-1.21.9-fabric.LQ3K71Q1.jar`)

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
