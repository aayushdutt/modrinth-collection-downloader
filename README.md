# Modrinth Collection Downloader

Script to download and update mods from a Modrinth Collection

## Requirements

`pip install requests`

## How to use

1. Clone this repository `git clone https://github.com/aayushdutt/modrinth-collection-downloader.git`
1. Update `config.json` update
   - `mc_version`: Minecraft version ("1.20.4", "1.21").
   - `loader`: "fabric", "forge", "quilt", etc.
   - `collection_id`: Collection id. Can be obtained from the collection URL (for `https://modrinth.com/collection/6OBQuutT` collection_id is `6OBQuutT`).
   - `mod_path`: Directory where mods will be downloaded

**Running**

- `python mods.py`: Download all mods in collection (will not update existing mods).
- `python mods.py --update`: Download and update mods to the latest version.
