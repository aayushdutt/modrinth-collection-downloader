import requests
import json
import os

MC_VERSION = "1.20.4"
LOADER = "fabric"  # "fabric, forge, quilt"
COLLECTION_ID = "<collection_id>"
MOD_PATH = "mods"

if not os.path.exists(MOD_PATH):
    os.mkdir(MOD_PATH)


def main():
    collection_res = requests.get(
        f"https://api.modrinth.com/v3/collection/{COLLECTION_ID}")
    if not collection_res.ok:
        print(f"Collection not found!")
        return
    collection_details = json.loads(collection_res.content)
    mods = collection_details["projects"]
    print("Mods in collection: ", mods)

    for item in mods:
        res = requests.get(
            f"https://api.modrinth.com/v2/project/{item}/version")

        if not res.ok:
            print(f"{item} versions not found!")
            continue

        mod_versions_data = json.loads(res.content)

        mod_version_to_download = next(
            (mod_version for mod_version in mod_versions_data
             if MC_VERSION in mod_version["game_versions"]
             and LOADER in mod_version["loaders"]), None)
        if not mod_version_to_download:
            print(
                f"No version found for {item} with MC_VERSION={MC_VERSION} and LOADER={LOADER}"
            )
            continue

        file_to_download = next((file
                                 for file in mod_version_to_download["files"]
                                 if file['primary'] == True), None)

        filename = file_to_download["filename"]
        if os.path.exists(f"{MOD_PATH}/{filename}"):
            print(f"File {filename} already exists, skipping...")
            continue

        print("Downloading: ", file_to_download['filename'],
              mod_version_to_download['loaders'],
              mod_version_to_download['game_versions'])
        mod_file = requests.get(file_to_download["url"]).content
        open(f"{MOD_PATH}/{filename}", 'wb').write(mod_file)


if __name__ == "__main__":
    main()
