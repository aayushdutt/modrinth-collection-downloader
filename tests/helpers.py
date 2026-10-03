"""Shared deterministic Modrinth fixtures for planning tests."""
import hashlib


def version(project, number, dependencies=(), channel="release", primary=True, loader="fabric"):
    content = (project + "-" + number).encode()
    return {
        "id": project + "-" + number, "project_id": project,
        "game_versions": ["26.2"], "loaders": [loader], "version_type": channel,
        "dependencies": list(dependencies),
        "files": [{"filename": project + "-" + number + ".jar", "url": project + "-" + number,
                   "primary": primary, "size": len(content),
                   "hashes": {"sha512": hashlib.sha512(content).hexdigest()}}],
    }


def dep(project=None, pin=None):
    return {"project_id": project, "version_id": pin, "dependency_type": "required"}


class FakeClient:
    def __init__(self, versions, roots=None, packs=()):
        self.versions = versions
        self.roots = list(versions) if roots is None else roots
        self.packs = packs
        self.downloads = []
        self.fail = set()
        self.exact = {data["id"]: data for values in versions.values() for data in values}

    def get_mod_project(self, project):
        if project not in self.versions:
            return None
        return {"title": project, "project_type": "resourcepack" if project in self.packs else "mod"}

    def get_mod_version(self, project):
        return self.versions.get(project)

    def get_version(self, identifier):
        return self.exact.get(identifier)

    def get_version_from_hash(self, digest, algorithm="sha512"):
        return next((data for data in self.exact.values() for artifact in data["files"]
                     if artifact["hashes"].get(algorithm) == digest), None)

    def get_collection(self, identifier):
        return {"projects": self.roots}

    def download_file(self, url, path, **kwargs):
        self.downloads.append(url)
        if url in self.fail:
            return False
        with open(path, "wb") as file:
            file.write(url.encode())
        return True
