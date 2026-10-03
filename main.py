import argparse
from collections import namedtuple
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
from http.client import HTTPException
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
from typing import Optional, Dict, List
from urllib import request, error, parse


VERSION_CHANNELS = ("release", "beta", "alpha")


def verify_file(filename, hashes=None, size=None) -> bool:
    """Check that a file is nonempty and matches available size and hashes."""
    if size is not None and (isinstance(size, bool) or not isinstance(size, int) or size < 0):
        return False
    if hashes is not None:
        if not isinstance(hashes, Mapping):
            return False
        if any(algorithm in hashes and not isinstance(hashes[algorithm], str)
               for algorithm in ("sha512", "sha1")):
            return False
    try:
        if not os.path.isfile(filename):
            return False
        actual_size = os.path.getsize(filename)
        if actual_size == 0 or (size is not None and actual_size != size):
            return False
        digests = {
            algorithm: hashlib.new(algorithm)
            for algorithm in ("sha512", "sha1")
            if hashes and algorithm in hashes
        }
        if digests:
            with open(filename, "rb") as source:
                for chunk in iter(lambda: source.read(65536), b""):
                    for digest in digests.values():
                        digest.update(chunk)
        return all(
            digest.hexdigest().lower() == hashes[algorithm].lower()
            for algorithm, digest in digests.items()
        )
    except OSError:
        return False


class ModrinthClient:
    """Client with bounded network retries and verified atomic downloads."""

    USER_AGENT = (
        "aayushdutt/modrinth-collection-downloader "
        "(https://github.com/aayushdutt/modrinth-collection-downloader)"
    )
    MAX_RETRY_DELAY = 2

    def __init__(self, base_url="https://api.modrinth.com", timeout=30, retries=2):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = max(0, retries)

    def _open(self, url):
        return request.urlopen(
            request.Request(url, headers={"User-Agent": self.USER_AGENT}),
            timeout=self.timeout,
        )

    def _request(self, operation):
        """Retry transient transport failures, never parsing or disk failures."""
        for attempt in range(self.retries + 1):
            delay = min(0.25 * (2 ** attempt), self.MAX_RETRY_DELAY)
            try:
                return operation()
            except error.HTTPError as exc:
                retryable = exc.code == 429 or 500 <= exc.code < 600
                for name in ("Retry-After", "X-Ratelimit-Reset"):
                    value = exc.headers.get(name) if exc.headers else None
                    if value is not None:
                        try:
                            retry_delay = float(value)
                            if math.isfinite(retry_delay):
                                delay = min(max(retry_delay, 0), self.MAX_RETRY_DELAY)
                                break
                        except ValueError:
                            pass
                exc.close()
                if not retryable or attempt == self.retries:
                    raise
                reason = str(exc)
            except (error.URLError, TimeoutError, ConnectionError, HTTPException) as exc:
                if attempt == self.retries:
                    raise
                reason = str(exc)
            print("Retrying request ({}/{}) in {:g}s: {}".format(
                attempt + 2, self.retries + 1, delay, reason), flush=True)
            time.sleep(delay)

    def get(self, url: str) -> Optional[dict]:
        """Make a GET request to the Modrinth API."""
        def fetch():
            with self._open(self.base_url + url) as response:
                return json.loads(response.read())

        try:
            return self._request(fetch)
        except (error.URLError, TimeoutError, ConnectionError, HTTPException) as exc:
            print(f"Network error: {exc}")
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            print(f"Failed to parse JSON response: {exc}")
        return None

    def download_file(self, url: str, filename: str, *, hashes=None, size=None) -> bool:
        """Verify a temporary download before replacing the destination."""
        def download():
            temporary = None
            try:
                with self._open(url) as response:
                    content_length = response.headers.get("Content-Length")
                    if content_length is not None:
                        try:
                            transfer_size = int(content_length)
                        except ValueError:
                            raise ValueError("Invalid download Content-Length")
                    else:
                        transfer_size = None
                    fd, temporary = tempfile.mkstemp(
                        prefix=".modrinth-", suffix=".part",
                        dir=os.path.dirname(os.path.abspath(filename)),
                    )
                    with os.fdopen(fd, "wb") as destination:
                        shutil.copyfileobj(response, destination)
                    if not verify_file(temporary, hashes, size):
                        raise ValueError("Downloaded file failed size/hash verification")
                    if transfer_size is not None and os.path.getsize(temporary) != transfer_size:
                        raise ValueError("Downloaded file does not match Content-Length")
                    os.replace(temporary, filename)
                    return True
            finally:
                if temporary is not None:
                    pending_exception = sys.exc_info()[0]
                    try:
                        os.unlink(temporary)
                    except FileNotFoundError:
                        pass  # Successfully moved to the destination.
                    except OSError as exc:
                        print(f"Could not remove partial download {temporary}: {exc}")
                        if pending_exception is None:
                            raise

        try:
            return self._request(download)
        except (OSError, HTTPException, ValueError) as exc:
            print(f"Failed to download file: {exc}")
            return False

    def get_mod_project(self, mod_id: str) -> Optional[dict]:
        """Get project details for a mod (includes name, slug, etc.)."""
        return self.get(f"/v2/project/{parse.quote(mod_id, safe='')}")

    def get_mod_version(self, mod_id: str) -> Optional[List[dict]]:
        """Get all versions for a mod."""
        return self.get(f"/v2/project/{parse.quote(mod_id, safe='')}/version")

    def get_version(self, version_id: str) -> Optional[dict]:
        """Resolve an exact version, including version-only dependencies."""
        return self.get(f"/v2/version/{parse.quote(version_id, safe='')}")

    def get_version_from_hash(self, file_hash: str, algorithm="sha512") -> Optional[dict]:
        """Identify the version installed in an existing local file."""
        query = parse.urlencode({"algorithm": algorithm})
        return self.get(f"/v2/version_file/{parse.quote(file_hash, safe='')}?{query}")

    def get_collection(self, collection_id: str) -> Optional[dict]:
        """Get collection details by ID."""
        return self.get(f"/v3/collection/{parse.quote(collection_id, safe='')}")


def extract_collection_id(collection_input: str) -> str:
    """Extract collection ID from URL or return as-is if already an ID.
    
    Examples:
        https://modrinth.com/collection/5OBQuutT -> 5OBQuutT
        5OBQuutT -> 5OBQuutT
    """
    # Check if it's a URL
    url_pattern = r'(?:https?://)?(?:www\.)?modrinth\.com/collection/([^/?]+)'
    match = re.search(url_pattern, collection_input)
    if match:
        return match.group(1)
    # Otherwise assume it's already an ID
    return collection_input.strip()


def safe_input(prompt: str) -> str:
    """Read input from user, using /dev/tty when stdin is piped.
    
    This allows interactive prompts to work even when the script is piped.
    """
    if sys.stdin.isatty():
        # Normal interactive mode
        return input(prompt)
    else:
        # Piped mode - read from terminal directly
        try:
            with open('/dev/tty', 'r') as tty:
                print(prompt, end='', flush=True)
                answer = tty.readline()
                if not answer:
                    raise EOFError("Input ended before a value was entered")
                return answer.rstrip('\n\r')
        except (OSError, IOError):
            # Fallback if /dev/tty is not available (Windows or unusual setup)
            raise RuntimeError("Cannot read input: stdin is not a terminal and /dev/tty is not available. Please provide arguments via command line.")


def required_input(prompt: str, label: str) -> str:
    """Keep asking for required values; closed input still exits normally."""
    while True:
        try:
            value = safe_input(prompt).strip()
        except EOFError:
            raise EOFError("{} is required, but input ended".format(label)) from None
        if value:
            return value
        print("{} is required. Please enter a value.".format(label), flush=True)


def parse_args(argv=None):
    """Parse command-line arguments and prompt for missing values."""
    parser = argparse.ArgumentParser(
        description="Download and update mods from a Modrinth collection."
    )
    parser.add_argument(
        "-c",
        "--collection",
        default=None,
        help="ID or URL of the collection to download (e.g., 5OBQuutT or https://modrinth.com/collection/5OBQuutT).",
    )
    parser.add_argument(
        "-v", "--version", default=None, help='Minecraft version (e.g., "26.2").'
    )
    parser.add_argument(
        "-l",
        "--loader",
        default=None,
        help='Loader to use (e.g., "fabric", "forge", "quilt"). Default: "fabric".',
    )
    parser.add_argument(
        "-d",
        "--directory",
        default="./mods",
        help='Directory to download mods to. Default: "./mods"',
    )
    parser.add_argument(
        "--resourcepacks-directory",
        default=None,
        help='Directory for resource packs. Default: sibling "resourcepacks" folder next to the mods directory.',
    )
    parser.add_argument(
        "-u",
        "--update",
        default=None,
        action="store_true",
        help="Download and update existing mods. Default: true",
    )
    parser.add_argument(
        "--no-update",
        dest="update",
        action="store_false",
        help="Do not update existing mods",
    )
    channel_options = parser.add_mutually_exclusive_group()
    channel_options.add_argument(
        "--channel",
        choices=VERSION_CHANNELS,
        default=None,
        help=(
            'Allowed version channels (release, beta, alpha). Default: "release" only. '
            '"beta" allows release then beta; "alpha" allows all channels.'
        ),
    )
    channel_options.add_argument(
        "--allow-prerelease",
        dest="channel",
        action="store_const",
        const="alpha",
        help="Allow beta/alpha versions when no release exists (same as --channel alpha).",
    )
    args = parser.parse_args(argv)
    for field in ("collection", "version", "loader"):
        value = getattr(args, field)
        if value is not None:
            value = value.strip()
            if not value:
                parser.error("--{} must not be empty".format(field))
            setattr(args, field, value)
    interactive = (
        not args.collection
        or not args.version
        or args.loader is None
        or args.update is None
    )
    
    # Prompt for missing required values (works even when piped via /dev/tty)
    if not args.collection:
        args.collection = required_input("Enter collection ID or URL: ", "Collection ID or URL")
    
    if not args.version:
        args.version = required_input('Enter Minecraft version (e.g., "26.2"): ', "Minecraft version")

    if args.loader is None:
        loader_input = safe_input(
            'Enter loader (e.g., "fabric", "forge", "quilt") [default: fabric]: '
        ).strip()
        args.loader = loader_input or "fabric"
    
    # Handle update flag (default True if not specified)
    if args.update is None:
        update_input = safe_input('Update existing mods? [Y/n] (default: Y): ').strip().lower()
        args.update = update_input not in ('n', 'no', 'false', '0')
    # If -u was provided, args.update is True; if --no-update was provided, it's False

    if args.channel is None:
        args.channel = "release"
        if interactive:
            prerelease_input = safe_input(
                "Allow prerelease (beta/alpha) when no release is available? [y/N]: "
            ).strip().lower()
            if prerelease_input in ("y", "yes", "true", "1"):
                args.channel = "alpha"

    # Extract collection ID from URL if needed
    args.collection = extract_collection_id(args.collection)

    if args.resourcepacks_directory is None:
        args.resourcepacks_directory = default_resourcepacks_directory(args.directory)
    
    return args


def default_resourcepacks_directory(mods_directory: str) -> str:
    """Return the standard sibling ``resourcepacks`` folder for a mods directory.

    Example: ``./mods`` -> ``./resourcepacks``; ``/instance/mods`` -> ``/instance/resourcepacks``.
    """
    parent = os.path.dirname(os.path.abspath(mods_directory))
    return os.path.join(parent, "resourcepacks")


def validate_directory(directory: str) -> bool:
    """Validate that the directory path is valid and create if needed.
    
    Returns True if directory is valid, False otherwise.
    """
    if os.path.exists(directory):
        if not os.path.isdir(directory):
            print(f"Error: '{directory}' exists but is not a directory")
            return False
    else:
        try:
            os.makedirs(directory, exist_ok=True)
        except OSError as e:
            print(f"Error: Failed to create directory '{directory}': {e}")
            return False
    return True


def get_existing_mods(directory: str) -> Dict[str, list]:
    """Index candidate managed filenames, retaining duplicates for reconciliation.

    A filename alone is only a candidate: the resolver confirms it against the
    project's published files before allowing deletion.
    """
    if not os.path.exists(directory):
        return {}
    existing = {}
    for filename in sorted(os.listdir(directory)):
        path = os.path.join(directory, filename)
        parts = filename.rsplit(".", 2)
        if os.path.isfile(path) and len(parts) == 3:
            project_id = parts[-2]
            existing.setdefault(project_id, []).append({
                "id": project_id, "filename": filename,
                "directory": os.path.abspath(directory),
            })
    return existing


def merge_existing_mods(mods_directory: str, resourcepacks_directory: str) -> Dict[str, list]:
    """Index both directories without losing duplicate files."""
    merged = get_existing_mods(mods_directory)
    if os.path.abspath(mods_directory) != os.path.abspath(resourcepacks_directory):
        for project_id, files in get_existing_mods(resourcepacks_directory).items():
            merged.setdefault(project_id, []).extend(files)
    return merged


def select_version(
    mod_versions_data: List[dict],
    game_version: str,
    loader: str,
    project_type: str = "mod",
    max_channel: str = "release",
) -> Optional[dict]:
    """Prefer release, then allowed prereleases; preserve newest-first API order."""
    channels = VERSION_CHANNELS[: VERSION_CHANNELS.index(max_channel) + 1]
    matching = [
        mod_version
        for mod_version in mod_versions_data
        if game_version in mod_version.get("game_versions", [])
        and _version_matches_loader(mod_version, loader, project_type)
    ]
    for channel in channels:
        for mod_version in matching:
            version_type = mod_version.get("version_type") or "release"
            if version_type == channel:
                return mod_version
    return None


def _version_matches_loader(
    mod_version: dict, loader: str, project_type: str
) -> bool:
    """Whether a version's loaders satisfy the requested loader filter."""
    loaders = mod_version.get("loaders", [])
    if loader in loaders:
        return True
    # Modrinth marks resource pack versions with loader ``minecraft`` only.
    if project_type == "resourcepack" and "minecraft" in loaders:
        return True
    return False


def resolve_target_directory(
    project_type: str,
    mods_directory: str,
    resourcepacks_directory: str,
    is_dependency: bool = False,
) -> str:
    """Choose mods vs resourcepacks folder for a project download."""
    if project_type == "resourcepack" and not is_dependency:
        return resourcepacks_directory
    return mods_directory


InstallConfig = namedtuple(
    "InstallConfig", "mods_directory resourcepacks_directory game_version loader update max_channel"
)
InstallResult = namedtuple("InstallResult", "project_id status updated message")
Plan = namedtuple("Plan", "roots nodes errors")


def managed_filename(filename, project_id):
    """Add the project ID before the extension, keeping filenames safe."""
    if not filename or filename in (".", "..") or "/" in filename or "\\" in filename:
        raise ValueError("Invalid artifact filename: {!r}".format(filename))
    if not isinstance(project_id, str) or not project_id or project_id in (".", "..") or "/" in project_id or "\\" in project_id:
        raise ValueError("Invalid project ID: {!r}".format(project_id))
    stem, extension = os.path.splitext(filename)
    return stem + "." + project_id + extension


def primary_file(version):
    files = version.get("files", [])
    return next((file for file in files if file.get("primary")), files[0] if files else None)


def existing_path(info):
    return os.path.join(info["directory"], info["filename"])


def artifact_valid(path, artifact):
    return verify_file(path, hashes=artifact.get("hashes"), size=artifact.get("size"))


class MetadataRequests:
    """One bounded metadata pool; only the coordinator owns its request cache."""

    METHODS = {
        "project": "get_mod_project", "versions": "get_mod_version",
        "version": "get_version", "hash": "get_version_from_hash",
    }

    def __init__(self, client, max_workers):
        self.client = client
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.futures = {}

    def schedule(self, kind, identifier):
        key = (kind, identifier)
        if key not in self.futures:
            method = getattr(self.client, self.METHODS[kind])
            self.futures[key] = self.executor.submit(method, identifier)

    def contains(self, kind, identifier):
        return (kind, identifier) in self.futures

    def pending(self, kind, identifier):
        future = self.futures.get((kind, identifier))
        return future is not None and not future.done()

    def result(self, kind, identifier):
        self.schedule(kind, identifier)
        return self.futures[(kind, identifier)].result()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        # Python 3.6 has no shutdown(cancel_futures=True). Cancel queued work
        # explicitly; bounded in-flight client requests finish before shutdown.
        for future in self.futures.values():
            future.cancel()
        self.executor.shutdown(wait=True)


class Resolver:
    """Resolve a collection once, then install each reachable project once.

    Exact pins constrain otherwise-unpinned roots. Rebuilding the reachable graph
    discards requirements from versions superseded by a pin.
    """

    def __init__(self, client, config, existing, progress=None, max_workers=5):
        self.client, self.config, self.existing = client, config, existing
        self.projects, self.versions, self.exact, self.installed = {}, {}, {}, {}
        self.progress = progress
        self.root_positions = {}
        self.max_workers = max_workers
        self.metadata = None

    def report(self, message):
        if self.progress is not None:
            self.progress(message)

    def project_label(self, project_id):
        title = self.projects.get(project_id, {}).get("title")
        return "{} ({})".format(title, project_id) if title else project_id

    def schedule_metadata(self, kind, identifier, message):
        caches = {"project": self.projects, "versions": self.versions, "version": self.exact}
        if identifier in caches.get(kind, {}):
            return
        if self.metadata is not None and not self.metadata.contains(kind, identifier):
            self.report(message)
            self.metadata.schedule(kind, identifier)

    def metadata_value(self, kind, identifier):
        if self.metadata is not None:
            if self.metadata.pending(kind, identifier):
                if kind == "hash":
                    self.report("  Waiting for installed-version lookup...")
                else:
                    label = self.project_label(identifier) if kind in ("project", "versions") else identifier
                    self.report("  Waiting for {} metadata: {}...".format(kind, label))
            return self.metadata.result(kind, identifier)
        # Helpers remain usable outside resolve; normal planning uses one pool.
        method = getattr(self.client, MetadataRequests.METHODS[kind])
        return method(identifier)

    def prefetch_project(self, project_id):
        managed_filename("artifact.jar", project_id)
        position = self.root_positions.get(project_id)
        prefix = "[{}/{}]".format(position, len(self.root_positions)) if position else "[dependency]"
        self.schedule_metadata("project", project_id,
                               "PLANNING {}: fetching project {}...".format(prefix, project_id))
        self.schedule_metadata("versions", project_id,
                               "  Fetching versions for {}...".format(self.project_label(project_id)))

    def prefetch_dependencies(self, dependencies):
        """Submit known owners and exact references before waiting for any."""
        for dep in dependencies:
            if dep.get("dependency_type") != "required":
                continue
            if dep.get("project_id"):
                try:
                    self.prefetch_project(dep["project_id"])
                except ValueError:
                    pass  # Graph traversal records invalid IDs as project errors.
            if dep.get("version_id"):
                self.schedule_metadata("version", dep["version_id"],
                                       "  Resolving required version {}...".format(dep["version_id"]))

    def project(self, project_id):
        self.prefetch_project(project_id)
        if project_id not in self.projects:
            data = self.metadata_value("project", project_id)
            if not data:
                raise ValueError("Project {} not found".format(project_id))
            self.projects[project_id] = data
            self.report("  Project metadata ready: {}".format(self.project_label(project_id)))
        return self.projects[project_id]

    def project_versions(self, project_id):
        self.prefetch_project(project_id)
        if project_id not in self.versions:
            self.versions[project_id] = self.metadata_value("versions", project_id) or []
        return self.versions[project_id]

    def exact_version(self, version_id):
        if version_id not in self.exact:
            self.schedule_metadata("version", version_id,
                                   "  Resolving required version {}...".format(version_id))
            self.exact[version_id] = self.metadata_value("version", version_id)
        data = self.exact[version_id]
        if not data or data.get("id") != version_id:
            raise ValueError("Required version {} not found".format(version_id))
        return data

    def installed_files(self, project_id):
        """Identify installed versions from published filenames, verifying bytes."""
        if project_id in self.installed:
            return self.installed[project_id]
        candidates = self.existing.get(project_id, [])
        if candidates:
            self.report("  Checking {} installed file(s) for {}...".format(
                len(candidates), self.project_label(project_id)))
        recognized = []
        for info in candidates:
            matches = [(version, artifact) for version in self.project_versions(project_id)
                       for artifact in version.get("files", [])
                       if managed_filename(artifact["filename"], project_id) == info["filename"]]
            # Published filenames can be reused between versions. Byte verification
            # determines the installed version instead of newest-first metadata.
            verified = [(version, artifact) for version, artifact in matches
                        if artifact_valid(existing_path(info), artifact)]
            if not verified and not self.config.update:
                self.report("  Identifying installed version for {}...".format(info["filename"]))
                with open(existing_path(info), "rb") as file:
                    digest = hashlib.sha512()
                    for chunk in iter(lambda: file.read(65536), b""):
                        digest.update(chunk)
                version = self.metadata_value("hash", digest.hexdigest())
                if version and version.get("project_id") == project_id:
                    verified = [(version, artifact) for artifact in version.get("files", [])
                                if artifact_valid(existing_path(info), artifact)]
            # In update mode, a published filename is sufficient ownership evidence
            # for replacing a corrupt artifact after the new bytes are verified.
            for version, artifact in verified or (matches[:1] if self.config.update else []):
                recognized.append((info, version, artifact))
        self.installed[project_id] = recognized
        return recognized

    def selected_version(self, project_id, pins):
        config = self.config
        data = self.project(project_id)
        installed = self.installed_files(project_id)
        if not config.update and self.existing.get(project_id):
            valid = [(info, version, artifact) for info, version, artifact in installed
                     if artifact_valid(existing_path(info), artifact)]
            versions = {version["id"] for _, version, _ in valid}
            if not valid or len(versions) != 1:
                raise ValueError("Cannot identify a single intact installed version for {} (--no-update)".format(project_id))
            selected = valid[0][1]
            if pins and pins != {selected["id"]}:
                raise ValueError("Installed {} conflicts with required version(s) {}".format(project_id, ", ".join(sorted(pins))))
            return selected
        if len(pins) > 1:
            raise ValueError("Conflicting required versions for {}: {}".format(project_id, ", ".join(sorted(pins))))
        if pins:
            selected = self.exact_version(next(iter(pins)))
            if selected.get("project_id") != project_id:
                raise ValueError("Pinned version belongs to a different project: {}".format(project_id))
            if (config.game_version not in selected.get("game_versions", []) or
                    not _version_matches_loader(selected, config.loader, data.get("project_type", "mod"))):
                raise ValueError("Pinned version is incompatible with Minecraft/loader: {}".format(project_id))
            allowed = VERSION_CHANNELS[:VERSION_CHANNELS.index(config.max_channel) + 1]
            if (selected.get("version_type") or "release") not in allowed:
                raise ValueError("Pinned prerelease for {} requires --channel {} or --allow-prerelease".format(
                    project_id, selected.get("version_type")))
        else:
            selected = select_version(self.project_versions(project_id), config.game_version,
                                      config.loader, data.get("project_type", "mod"), config.max_channel)
        if not selected:
            raise ValueError("No compatible version for {}".format(project_id))
        return selected

    def resolve(self, roots):
        roots = list(dict.fromkeys(roots))
        self.root_positions = {pid: index + 1 for index, pid in enumerate(roots)}
        with MetadataRequests(self.client, self.max_workers) as metadata:
            self.metadata = metadata
            try:
                for project_id in roots:
                    try:
                        self.prefetch_project(project_id)
                    except ValueError:
                        pass  # Selection reports invalid root IDs independently.
                return self.resolve_graph(roots)
            finally:
                self.metadata = None

    def resolve_graph(self, roots):
        pins, seen = {}, set()
        # A bound protects malformed or oscillating requirement graphs.
        for iteration in range(100):
            if iteration:
                self.report("  Checking dependency version constraints (pass {})...".format(iteration + 1))
            nodes, errors, next_pins = {}, {}, {}
            queue = list(roots)
            dependencies = set()
            while queue:
                project_id = queue.pop(0)
                if project_id in nodes or project_id in errors:
                    continue
                try:
                    selected = self.selected_version(project_id, pins.get(project_id, set()))
                    self.report("  Selected {}: {} ({})".format(
                        self.project_label(project_id), selected.get("version_number") or selected["id"],
                        selected.get("version_type") or "release"))
                    node = {"version": selected, "project": self.project(project_id),
                            "dependencies": set(), "existing": self.installed_files(project_id)}
                    nodes[project_id] = node
                    self.prefetch_dependencies(selected.get("dependencies", []))
                    for dep in selected.get("dependencies", []):
                        if dep.get("dependency_type") != "required":
                            continue
                        dep_id, version_id = dep.get("project_id"), dep.get("version_id")
                        try:
                            # Retain identifiable edges even if a pin is missing,
                            # and continue collecting later requirements on error.
                            if dep_id:
                                node["dependencies"].add(dep_id)
                                dependencies.add(dep_id)
                                queue.append(dep_id)
                            if version_id:
                                dep_version = self.exact_version(version_id)
                                owner = dep_version.get("project_id")
                                if not owner or (dep_id and dep_id != owner):
                                    raise ValueError("Invalid required dependency {}".format(version_id))
                                dep_id = owner
                                self.prefetch_project(dep_id)
                                next_pins.setdefault(dep_id, set()).add(version_id)
                            if not dep_id:
                                raise ValueError("Required dependency has no project/version ID")
                            node["dependencies"].add(dep_id)
                            dependencies.add(dep_id)
                            queue.append(dep_id)
                        except (ValueError, OSError, error.URLError) as exc:
                            previous = errors.get(project_id)
                            errors[project_id] = (previous + "; " if previous else "") + str(exc)
                except (ValueError, OSError, error.URLError) as exc:
                    errors[project_id] = str(exc)
            for project_id, node in nodes.items():
                node["is_dependency"] = project_id in dependencies and project_id not in roots
                node["is_root"] = project_id in roots
            if pins == next_pins:
                return self.finalize_plan(roots, nodes, errors)
            state = tuple(sorted((key, tuple(sorted(value))) for key, value in next_pins.items()))
            if state in seen:
                # Do not install a plan which alternates between incompatible selections.
                changing = {pid for pid in set(pins) | set(next_pins)
                            if pins.get(pid) != next_pins.get(pid)}
                affected = set(nodes) & changing
                while True:
                    parents = {pid for pid, node in nodes.items() if node["dependencies"] & affected}
                    if parents <= affected:
                        break
                    affected |= parents
                for project_id in affected:
                    errors[project_id] = "Dependency constraints do not converge"
                return self.finalize_plan(roots, nodes, errors)
            seen.add(state)
            pins = next_pins
        return self.finalize_plan(roots, nodes, dict((pid, "Dependency resolution limit exceeded") for pid in nodes))


    def finalize_plan(self, roots, nodes, errors):
        """Connect old installed requirements for rollback, without selecting them.

        Dependencies removed by an update can still be independently scheduled
        roots. Their replacement must roll back if the old parent remains.
        """
        # Failed selection can leave an installed parent outside the selected
        # graph. Retain its cached verified metadata for transaction connectivity;
        # the existing error still prevents any installation of this record.
        if any(self.installed.values()):
            self.report("  Checking installed dependency compatibility...")
        for project_id in errors:
            if project_id in nodes:
                continue
            installed = [(info, version, artifact)
                         for info, version, artifact in self.installed.get(project_id, [])
                         if artifact_valid(existing_path(info), artifact)]
            if installed:
                nodes[project_id] = {
                    "version": installed[0][1], "project": self.projects.get(project_id, {}),
                    "dependencies": set(), "existing": installed,
                    "is_dependency": project_id not in roots, "is_root": project_id in roots,
                }
        processed = set(nodes) | set(errors)
        for node in nodes.values():
            for info, version, artifact in node["existing"]:
                if artifact_valid(existing_path(info), artifact):
                    for dep in version.get("dependencies", []):
                        if dep.get("dependency_type") == "required" and not dep.get("project_id") and dep.get("version_id"):
                            self.schedule_metadata("version", dep["version_id"],
                                                   "  Resolving installed dependency version {}...".format(dep["version_id"]))
        for project_id, node in nodes.items():
            historical = set()
            seen_versions = set()
            for info, version, artifact in node["existing"]:
                if version["id"] in seen_versions or not artifact_valid(existing_path(info), artifact):
                    continue
                seen_versions.add(version["id"])
                for dep in version.get("dependencies", []):
                    if dep.get("dependency_type") != "required":
                        continue
                    owner = dep.get("project_id")
                    try:
                        if not owner and dep.get("version_id"):
                            owner = self.exact_version(dep["version_id"]).get("project_id")
                        if not owner:
                            raise ValueError("Cannot identify installed required dependency")
                        if owner in processed:
                            historical.add(owner)
                    except (ValueError, OSError, error.URLError) as exc:
                        previous = errors.get(project_id)
                        message = "Cannot identify installed dependency for {}: {}".format(project_id, exc)
                        errors[project_id] = (previous + "; " if previous else "") + message
                        # Unknown ownership cannot justify replacing another
                        # scheduled project while retaining this installed parent.
                        historical.update(processed - {project_id})
            node["transaction_dependencies"] = historical
        return Plan(roots, nodes, errors)


def selected_artifact(node, config):
    artifact = primary_file(node["version"])
    if not config.update and node["existing"]:
        artifact = next(file for info, version, file in node["existing"]
                        if version["id"] == node["version"]["id"] and artifact_valid(existing_path(info), file))
    if not artifact:
        raise ValueError("Version has no downloadable files")
    return artifact


def target_path(project_id, node, config, artifact):
    directory = resolve_target_directory(node["project"].get("project_type", "mod"),
                                         config.mods_directory, config.resourcepacks_directory,
                                         node["is_dependency"])
    return os.path.join(directory, managed_filename(artifact["filename"], project_id))


def install_project(project_id, node, client, config):
    """Install one dependency-ready artifact; never mutate shared run state."""
    try:
        version = node["version"]
        installed = node["existing"]
        target_dir = resolve_target_directory(node["project"].get("project_type", "mod"),
                                              config.mods_directory, config.resourcepacks_directory,
                                              node["is_dependency"])
        if not validate_directory(target_dir):
            return InstallResult(project_id, "failed", False, "Cannot create target directory")
        artifact = selected_artifact(node, config)
        target = target_path(project_id, node, config, artifact)
        valid_target = artifact_valid(target, artifact)
        changed = False
        if not valid_target:
            source = next((existing_path(info) for info, selected, file in installed
                           if selected["id"] == version["id"] and file["filename"] == artifact["filename"]
                           and artifact_valid(existing_path(info), file)), None)
            if source:
                # Atomic replacement even when migrating between filesystems.
                fd, staged = tempfile.mkstemp(prefix=".modrinth-", dir=target_dir)
                os.close(fd)
                try:
                    shutil.copyfile(source, staged)
                    if not artifact_valid(staged, artifact):
                        raise OSError("Copied artifact failed verification")
                    os.replace(staged, target)
                finally:
                    if os.path.exists(staged):
                        os.unlink(staged)
            elif not client.download_file(artifact["url"], target,
                                          hashes=artifact.get("hashes"), size=artifact.get("size")):
                return InstallResult(project_id, "failed", False, "Download failed")
            if not artifact_valid(target, artifact):
                return InstallResult(project_id, "failed", False, "Installed artifact failed verification")
            changed = True
        # Delete only positively identified managed files, after canonical bytes
        # are verified. Unrelated files resembling project IDs remain untouched.
        for info, _, _ in installed:
            path = existing_path(info)
            if os.path.abspath(path) != os.path.abspath(target) and os.path.exists(path):
                os.remove(path)
                changed = True
        status = "downloaded" if not valid_target else "skipped"
        return InstallResult(project_id, status, bool(installed) and changed, "")
    except (OSError, ValueError, error.URLError) as exc:
        return InstallResult(project_id, "failed", False, str(exc))


def dependency_components(plan):
    """Disjoint components are independent installation transactions."""
    neighbors = {pid: set() for pid in set(plan.nodes) | set(plan.errors)}
    for pid, node in plan.nodes.items():
        for dependency in node["dependencies"] | node.get("transaction_dependencies", set()):
            neighbors.setdefault(dependency, set()).add(pid)
            neighbors[pid].add(dependency)
    remaining = set(neighbors)
    while remaining:
        pending, component = [min(remaining)], set()
        while pending:
            pid = pending.pop()
            if pid not in component:
                component.add(pid)
                pending.extend(neighbors[pid] - component)
        remaining -= component
        yield component


def stage_project(project_id, node, client, config, staging):
    """Download or copy verified bytes without changing installed files."""
    try:
        artifact = selected_artifact(node, config)
        staged = os.path.join(staging, project_id)
        candidates = [target_path(project_id, node, config, artifact)]
        candidates.extend(existing_path(info) for info, version, file in node["existing"]
                          if version["id"] == node["version"]["id"] and file["filename"] == artifact["filename"])
        source = next((path for path in candidates if artifact_valid(path, artifact)), None)
        if source:
            shutil.copyfile(source, staged)
        elif not client.download_file(artifact["url"], staged,
                                      hashes=artifact.get("hashes"), size=artifact.get("size")):
            return InstallResult(project_id, "failed", False, "Download failed while staging")
        if not artifact_valid(staged, artifact):
            return InstallResult(project_id, "failed", False, "Staged artifact failed verification")
        return InstallResult(project_id, "staged", False, staged)
    except (OSError, ValueError, error.URLError) as exc:
        return InstallResult(project_id, "failed", False, str(exc))


def component_order(plan, component):
    """Return dependency-first order or component resolution/cycle errors."""
    errors = {pid: message for pid, message in plan.errors.items() if pid in component}
    order, pending = [], component - set(errors)
    while pending:
        ready = sorted(pid for pid in pending if plan.nodes[pid]["dependencies"] <= set(order))
        if not ready:
            reason = "Required dependency failed" if errors else "Cyclic required dependencies"
            errors.update((pid, reason) for pid in pending)
            break
        order.extend(ready)
        pending -= set(ready)
    return order, errors


def failed_component(component, failures, reason):
    return {pid: InstallResult(pid, "failed", False, failures.get(pid, reason)) for pid in component}


class StagedClient:
    """Commit already-verified bytes via an atomic destination replacement."""

    def download_file(self, url, filename, **verification):
        fd, temporary = tempfile.mkstemp(prefix=".modrinth-", dir=os.path.dirname(filename))
        os.close(fd)
        try:
            shutil.copyfile(self.source, temporary)
            os.replace(temporary, filename)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return True


def rollback_component(originals):
    failures = []
    for path, backup in originals.items():
        try:
            if backup:
                fd, restored = tempfile.mkstemp(prefix=".modrinth-restore-", dir=os.path.dirname(path))
                os.close(fd)
                try:
                    shutil.copyfile(backup, restored)
                    os.replace(restored, path)
                finally:
                    if os.path.exists(restored):
                        os.unlink(restored)
            elif os.path.exists(path):
                os.remove(path)
        except OSError as exc:
            failures.append("{}: {}".format(path, exc))
    return failures


def retain_recovery(backups, originals):
    """Keep recoverable originals when the filesystem prevents automatic rollback."""
    with open(os.path.join(backups, "original-paths.json"), "w") as manifest:
        json.dump({path: os.path.basename(backup) if backup else None
                   for path, backup in originals.items()}, manifest, indent=2)
    recovery = tempfile.mkdtemp(prefix="modrinth-recovery-")
    try:
        os.rename(backups, os.path.join(recovery, "originals"))
    except OSError:
        os.rmdir(recovery)
        raise
    return recovery


def commit_component(plan, component, order, staged, config, staging, retained):
    """Snapshot and commit one component, restoring originals on failure."""
    originals, committed = {}, {}
    backups = tempfile.mkdtemp(prefix="backups-", dir=staging)
    try:
        for pid in order:
            node = plan.nodes[pid]
            paths = [existing_path(info) for info, _, _ in node["existing"]]
            paths.append(target_path(pid, node, config, selected_artifact(node, config)))
            for path in paths:
                path = os.path.abspath(path)
                if path in originals:
                    continue
                backup = None
                if os.path.isfile(path):
                    backup = os.path.join(backups, str(len(originals)))
                    shutil.copyfile(path, backup)
                originals[path] = backup
        client = StagedClient()
        for pid in order:
            client.source = staged[pid].message
            result = install_project(pid, plan.nodes[pid], client, config)
            if result.status == "failed":
                raise OSError("{}: {}".format(pid, result.message))
            committed[pid] = result
    except (OSError, ValueError, KeyboardInterrupt) as exc:
        failures = rollback_component(originals)
        message = "Installation rolled back: {}".format(exc)
        if failures:
            message = "Installation failed: {}; Rollback incomplete: ".format(exc) + "; ".join(failures)
            try:
                recovery = retain_recovery(backups, originals)
                message += "; original files retained at " + recovery
            except OSError as recovery_error:
                retained.add(staging)
                message += "; recovery staging retained at {} ({})".format(staging, recovery_error)
        if isinstance(exc, KeyboardInterrupt):
            if failures:
                print("ERROR: " + message, flush=True)
            raise
        return failed_component(component, {}, message)
    for pid in order:
        print("{}: {}".format(committed[pid].status.upper(), pid), flush=True)
    return committed


@contextmanager
def staging_directory(retained):
    staging = tempfile.mkdtemp(prefix="modrinth-stage-")
    try:
        yield staging
    finally:
        if staging not in retained:
            shutil.rmtree(staging)


def current_component(plan, order, config):
    """A verified, canonical component requires no copies or backups."""
    try:
        for pid in order:
            node = plan.nodes[pid]
            artifact = selected_artifact(node, config)
            target = os.path.abspath(target_path(pid, node, config, artifact))
            if not artifact_valid(target, artifact) or any(
                    os.path.abspath(existing_path(info)) != target for info, _, _ in node["existing"]):
                return False
        return True
    except (OSError, ValueError):
        return False


def print_channel_warning(pid, node):
    selected = node["version"]
    channel = selected.get("version_type") or "release"
    if channel != "release":
        title = node["project"].get("title") or pid
        number = selected.get("version_number") or selected["id"]
        print("WARNING: Using {} {} for {} ({})".format(channel, number, title, pid), flush=True)


def execute_plan(plan, client, config, max_workers=5):
    """Stage all components with one bounded pool, then commit independently.

    A failed parent download leaves its previous dependencies intact. Independent
    components can still succeed. Cyclic required graphs are rejected explicitly.
    """
    results, valid_components = {}, []
    for component in dependency_components(plan):
        order, errors = component_order(plan, component)
        if errors:
            results.update(failed_component(component, errors, "Required dependency component failed"))
        else:
            for pid in order:
                print_channel_warning(pid, plan.nodes[pid])
            if current_component(plan, order, config):
                for pid in order:
                    results[pid] = InstallResult(pid, "skipped", False, "")
                    print("SKIPPED: {}".format(pid), flush=True)
            else:
                valid_components.append((component, order))
    if not valid_components:
        return results
    retained = set()
    with staging_directory(retained) as staging:
        artifacts = os.path.join(staging, "artifacts")
        os.makedirs(artifacts)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {}
            for _, order in valid_components:
                for pid in order:
                    node = plan.nodes[pid]
                    selected = node["version"]
                    title = node["project"].get("title") or pid
                    number = selected.get("version_number") or selected["id"]
                    print("PREPARING: {} ({}) - {}".format(title, pid, number), flush=True)
                    futures[pid] = executor.submit(stage_project, pid, node, client, config, artifacts)
            for component, order in valid_components:
                staged = {pid: futures[pid].result() for pid in order}
                failures = {pid: result.message for pid, result in staged.items() if result.status == "failed"}
                if failures:
                    results.update(failed_component(component, failures, "Dependency component staging failed"))
                else:
                    results.update(commit_component(plan, component, order, staged, config, staging, retained))
    return results


def aggregate_results(plan, results):
    stats = dict(downloaded=0, updated=0, skipped=0, failed=0)
    for pid, result in results.items():
        prefix = "main_" if pid in plan.roots else "deps_"
        stats[result.status] += 1
        stats[prefix + result.status] = stats.get(prefix + result.status, 0) + 1
        if result.updated:
            stats["updated"] += 1
            stats[prefix + "updated"] = stats.get(prefix + "updated", 0) + 1
    return stats


def print_summary(plan, results):
    stats = aggregate_results(plan, results)
    print("\n" + "=" * 50 + "\nSUMMARY\n" + "=" * 50)
    for label, prefix in (("Main Mods (from collection)", "main_"), ("Dependencies (required by mods)", "deps_")):
        count = sum(stats.get(prefix + state, 0) for state in ("downloaded", "skipped", "failed"))
        if prefix == "deps_" and not count:
            continue
        print("\n{}:".format(label))
        print("  Total processed: {}".format(count))
        for state in ("downloaded", "updated", "skipped", "failed"):
            print("  {}: {}".format(state.capitalize(), stats.get(prefix + state, 0)))
    print("\nOverall Totals:")
    print("  Total mods and dependencies processed: {}".format(len(results)))
    for state in ("downloaded", "updated", "skipped", "failed"):
        print("  {}: {}".format(state.capitalize(), stats[state]))
    for pid, result in sorted(results.items()):
        if result.status == "failed":
            print("  ERROR: {}: {}".format(pid, result.message))
    print("=" * 50)


def main(argv=None, client=None):
    """Return a process exit status, allowing deterministic offline integration."""
    try:
        args = parse_args(argv)
        if not args.collection or not args.version or not args.loader:
            print("ERROR: Collection ID, version, and loader are required")
            return 1
        if not validate_directory(args.directory):
            return 1
        client = client or ModrinthClient()
        print("Fetching collection {}...".format(args.collection), flush=True)
        collection = client.get_collection(args.collection)
        if not collection:
            print("ERROR: Collection id={} not found or inaccessible".format(args.collection))
            return 1
        roots = collection.get("projects", [])
        if not roots:
            print("WARNING: Collection {} contains no mods".format(args.collection))
            return 0
        print("Found {} mod(s) in collection".format(len(roots)), flush=True)
        print("Version channel policy: {}".format(args.channel), flush=True)
        config = InstallConfig(args.directory, args.resourcepacks_directory, args.version,
                               args.loader, args.update, args.channel)
        print("Planning collection and required dependencies...", flush=True)
        started = time.monotonic()
        existing = merge_existing_mods(args.directory, args.resourcepacks_directory)
        plan = Resolver(client, config, existing,
                        progress=lambda message: print(message, flush=True)).resolve(roots)
        processed = set(plan.nodes) | set(plan.errors)
        print("Plan ready in {:.1f}s: {} project(s), {} dependencies, {} resolution error(s).".format(
            time.monotonic() - started, len(plan.roots), len(processed - set(plan.roots)),
            len(plan.errors)), flush=True)
        results = execute_plan(plan, client, config)
        print_summary(plan, results)
        return int(any(result.status == "failed" for result in results.values()))
    except (EOFError, RuntimeError, ValueError, OSError, error.URLError) as exc:
        print("ERROR: {}".format(exc))
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
