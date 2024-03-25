from concurrent.futures import ThreadPoolExecutor
import json
import os
from urllib import request, error

with open("config.json", "r") as f:
    config = json.load(f)

MC_VERSION = config["mc_version"]  # "1.20.4"
LOADER = config["loader"]  # "fabric, forge, quilt"
COLLECTION_ID = config["collection_id"]
MOD_PATH = config["mod_path"]

if not os.path.exists(MOD_PATH):
    os.mkdir(MOD_PATH)


class ModrinthClient:

    def __init__(self):
        self.base_url = "https://api.modrinth.com"

    def get(self, url):
        try:
            with request.urlopen(self.base_url + url) as response:
                return json.loads(response.read())
        except error.URLError as e:
            print(f"Network error: {e}")
            return None

    def download_file(self, url, filename):
        try:
            request.urlretrieve(url, filename)
        except error.URLError as e:
            print(f"Failed to download file: {e}")

    def get_mod_version(self, mod_id):
        return self.get(f"/v2/project/{mod_id}/version")

    def get_collection(self, collection_id):
        return self.get(f"/v3/collection/{collection_id}")


modrinth_client = ModrinthClient()


def get_existing_mods() -> list[dict]:
    file_names = os.listdir(MOD_PATH)
    return [{
        "id": file_name.split(".")[-2],
        "filename": file_name
    } for file_name in file_names]


def get_latest_version(mod_id):
    mod_versions_data = modrinth_client.get_mod_version(mod_id)
    if not mod_versions_data:
        print(f"{mod_id} versions not found!")
        return None

    mod_version_to_download = next(
        (mod_version for mod_version in mod_versions_data
         if MC_VERSION in mod_version["game_versions"]
         and LOADER in mod_version["loaders"]), None)
    return mod_version_to_download


def download_mod(mod_id, update=False, existing_mods=[]):
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
    modrinth_client.download_file(file_to_download["url"],
                                  f"{MOD_PATH}/{filename_with_id}")

    if existing_mod:
        print(f"Removing previous version: {existing_mod['filename']}")
        os.remove(f"{MOD_PATH}/{existing_mod['filename']}")


def main():
    collection_details = modrinth_client.get_collection(COLLECTION_ID)
    if not collection_details:
        print(f"Collection id={COLLECTION_ID} not found")
        return
    mods: str = collection_details["projects"]
    print("Mods in collection: ", mods)
    existing_mods = get_existing_mods()
    should_update = "--update" in os.sys.argv or "--upgrade" in os.sys.argv

    with ThreadPoolExecutor(max_workers=5) as executor:
        executor.map(download_mod, mods, [should_update] * len(mods),
                     [existing_mods] * len(mods))


if __name__ == "__main__":
    main()
