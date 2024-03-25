# Modrinth Collection Downloader

Script to download and update mods from a Modrinth Collection

## How to use

```sh
wget -qO- https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python - -v <minecraft_version> -l <loader> -c <your_collection_id>
```

OR using `curl`

```sh
curl -sL https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python - -v <minecraft_version> -l <loader> -c <your_collection_id>
```

OR copy the `main.py` file locally and run

```sh
python main.py -v <minecraft_version> -l <loader> -c <your_collection_id>
```

### Examples:

- `wget -qO- https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python - -v 1.20.4 -l fabric -c 5OBQuutT`
- `wget -qO- https://raw.githubusercontent.com/aayushdutt/modrinth-collection-downloader/master/main.py | python - -v 1.20.4 -l fabric -c 5OBQuutT -d mymods -u`
  - Saves the mods to mymods and updates existing ones to latest version

### Options:

```
  -h, --help            show this help message and exit
  -c COLLECTION, --collection COLLECTION
                        ID of the collection to download. Can be obtained from the collection URL (for
                        https://modrinth.com/collection/5OBQuutT collection_id is 5OBQuutT).
  -v VERSION, --version VERSION
                        Minecraft version ("1.20.4", "1.21").
  -l LOADER, --loader LOADER
                        Loader to use ("fabric", "forge", "quilt" etc).
  -d DIRECTORY, --directory DIRECTORY
                        Directory to download mods to. Default: "mods"
  -u, --update          Download and update existing mods. Default: false
```
