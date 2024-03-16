from concurrent.futures import ThreadPoolExecutor
import json
import os
import requests

with open("config.json", "r") as f:
    config = json.load(f)
MC_VERSION = config["mc_version"]  # "1.20.4"
LOADER = config["loader"]  # "fabric, forge, quilt"
COLLECTION_ID = config["collection_id"]
MOD_PATH = config["mod_path"]

if not os.path.exists(MOD_PATH):
    os.mkdir(MOD_PATH)


def get_existing_mods() -> list[dict]:
    file_names = os.listdir(MOD_PATH)
    return [{
        "id": file_name.split(".")[-2],
        "filename": file_name
    } for file_name in file_names]


def get_latest_version(mod_id: str) -> dict | None:
    res = requests.get(f"https://api.modrinth.com/v2/project/{mod_id}/version")
    if not res.ok:
        print(f"{mod_id} versions not found!")
        return None

    mod_versions_data = json.loads(res.content)

    mod_version_to_download = next(
        (mod_version for mod_version in mod_versions_data
         if MC_VERSION in mod_version["game_versions"]
         and LOADER in mod_version["loaders"]), None)
    return mod_version_to_download


def download_mod(mod_id: str, update: bool = False, existing_mods: list = []):
    existing_mod = next((mod for mod in existing_mods if mod["id"] == mod_id),
                        None)
    if not update and existing_mod:
        print(f"{mod_id} already exists, skipping...")
        return

    latest_mod = get_latest_version(mod_id)
    if not latest_mod:
        print(
            f"No version found for {mod_id} with MC_VERSION={MC_VERSION} and LOADER={LOADER}"
        )
        return

    file_to_download: dict | None = next(
        (file for file in latest_mod["files"] if file['primary'] == True),
        None)
    if not file_to_download:
        print(f"Couldn't find a file to download for {mod_id}")
        return
    filename: str = file_to_download["filename"]
    filename_parts = filename.split(".")
    filename_parts.insert(-1, mod_id)
    filename_with_id = ".".join(filename_parts)

    if existing_mod and existing_mod["filename"] == filename_with_id:
        print(f"{filename_with_id} latest version already exists.")
        return

    print("Updating: " if existing_mod else "Downloading: ",
          file_to_download['filename'], latest_mod['loaders'],
          latest_mod['game_versions'])
    mod_file = requests.get(file_to_download["url"]).content
    with open(f"{MOD_PATH}/{filename_with_id}", 'wb') as f:
        f.write(mod_file)

    if existing_mod:
        print(f"Removing previous version: {existing_mod['filename']}")
        os.remove(f"{MOD_PATH}/{existing_mod['filename']}")


def main():
    collection_res = requests.get(
        f"https://api.modrinth.com/v3/collection/{COLLECTION_ID}")
    if not collection_res.ok:
        print(f"Collection not found!")
        return
    collection_details = json.loads(collection_res.content)
    mods: str = collection_details["projects"]
    print("Mods in collection: ", mods)
    existing_mods = get_existing_mods()
    should_update = "--update" in os.sys.argv or "--upgrade" in os.sys.argv

    with ThreadPoolExecutor(max_workers=5) as executor:
        executor.map(download_mod, mods, [should_update] * len(mods),
                     [existing_mods] * len(mods))


if __name__ == "__main__":
    main()
