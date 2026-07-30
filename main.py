import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
import shutil
import sys
from typing import Optional, Dict, List
from urllib import request, error


class ModrinthClient:
    """Client for interacting with the Modrinth API."""

    def __init__(self):
        self.base_url = "https://api.modrinth.com"

    def get(self, url: str) -> Optional[dict]:
        """Make a GET request to the Modrinth API."""
        try:
            with request.urlopen(self.base_url + url) as response:
                return json.loads(response.read())
        except error.URLError as e:
            print(f"Network error: {e}")
            return None
        except json.JSONDecodeError as e:
            print(f"Failed to parse JSON response: {e}")
            return None

    def download_file(self, url: str, filename: str) -> bool:
        """Download a file from the given URL to the specified filename.
        
        Returns True if download succeeded, False otherwise.
        """
        try:
            request.urlretrieve(url, filename)
            # Verify file was created and has content
            if os.path.exists(filename) and os.path.getsize(filename) > 0:
                return True
            return False
        except error.URLError as e:
            print(f"Failed to download file: {e}")
            return False
        except Exception as e:
            print(f"Unexpected error during download: {e}")
            return False

    def get_mod_project(self, mod_id: str) -> Optional[dict]:
        """Get project details for a mod (includes name, slug, etc.)."""
        return self.get(f"/v2/project/{mod_id}")

    def get_mod_version(self, mod_id: str) -> Optional[List[dict]]:
        """Get all versions for a mod."""
        return self.get(f"/v2/project/{mod_id}/version")

    def get_collection(self, collection_id: str) -> Optional[dict]:
        """Get collection details by ID."""
        return self.get(f"/v3/collection/{collection_id}")


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
                return tty.readline().rstrip('\n\r')
        except (OSError, IOError):
            # Fallback if /dev/tty is not available (Windows or unusual setup)
            raise RuntimeError("Cannot read input: stdin is not a terminal and /dev/tty is not available. Please provide arguments via command line.")


def parse_args():
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
    args = parser.parse_args()
    
    # Prompt for missing required values (works even when piped via /dev/tty)
    if not args.collection:
        args.collection = safe_input("Enter collection ID or URL: ").strip()
    
    if not args.version:
        args.version = safe_input('Enter Minecraft version (e.g., "26.2"): ').strip()

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


def get_existing_mods(directory: str) -> Dict[str, Dict[str, str]]:
    """Get existing mods from the directory.
    
    Returns a dictionary mapping mod_id to mod info dict with keys:
    ``id``, ``filename``, and ``directory`` (absolute path where the file lives).
    Handles edge cases like files without extensions or unusual names.
    """
    if not os.path.exists(directory):
        return {}
    
    abs_dir = os.path.abspath(directory)
    existing_mods: Dict[str, Dict[str, str]] = {}
    try:
        for item in os.listdir(directory):
            item_path = os.path.join(directory, item)
            # Only process files, skip directories
            if not os.path.isfile(item_path):
                continue
            
            # Extract mod_id from filename
            # Format: filename.modid.ext or filename.modid
            parts = item.rsplit(".", 2)
            if len(parts) >= 2:
                # Has at least one dot, mod_id should be second-to-last part
                mod_id = parts[-2]
                existing_mods[mod_id] = {
                    "id": mod_id,
                    "filename": item,
                    "directory": abs_dir,
                }
            else:
                # No extension, skip or handle differently
                # For now, we'll skip files without proper format
                continue
    except OSError as e:
        print(f"Warning: Failed to read directory '{directory}': {e}")
    
    return existing_mods


def merge_existing_mods(
    mods_directory: str, resourcepacks_directory: str
) -> Dict[str, Dict[str, str]]:
    """Index files in both ``mods`` and ``resourcepacks`` for skip/update logic."""
    merged = dict(get_existing_mods(mods_directory))
    for mod_id, info in get_existing_mods(resourcepacks_directory).items():
        merged[mod_id] = info
    return merged


def get_mod_name(
    modrinth_client: ModrinthClient,
    mod_id: str,
    project_data: Optional[dict] = None,
) -> str:
    """Get the mod name (title or slug) for display purposes."""
    data = project_data if project_data is not None else modrinth_client.get_mod_project(mod_id)
    if data:
        # Prefer title, fallback to slug, fallback to mod_id
        return data.get("title") or data.get("slug") or mod_id
    return mod_id


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


def get_latest_version(
    modrinth_client: ModrinthClient,
    mod_id: str,
    version: str,
    loader: str,
    project_type: str = "mod",
) -> Optional[dict]:
    """Get the latest version of a mod matching the specified version and loader."""
    mod_versions_data = modrinth_client.get_mod_version(mod_id)
    if not mod_versions_data:
        return None

    mod_version_to_download = next(
        (
            mod_version
            for mod_version in mod_versions_data
            if version in mod_version.get("game_versions", [])
            and _version_matches_loader(mod_version, loader, project_type)
        ),
        None,
    )
    return mod_version_to_download


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


def download_mod(
    mod_id: str,
    modrinth_client: ModrinthClient,
    mods_directory: str,
    resourcepacks_directory: str,
    version: str,
    loader: str,
    update: bool,
    existing_mods: Dict[str, Dict[str, str]],
    stats: Dict[str, int],
    failed_mods: List[str],
    processed_mods: Optional[set] = None,
    is_dependency: bool = False,
    parent_mod_id: Optional[str] = None,
) -> None:
    """Download or update a mod.
    
    Updates the stats dictionary with results and appends to failed_mods list on failure.
    Also handles downloading required dependencies recursively.
    
    Args:
        processed_mods: Set of mod IDs that have already been processed (to avoid circular dependencies).
        is_dependency: Whether this mod is being downloaded as a dependency.
        parent_mod_id: ID of the parent mod that requires this dependency (for logging).
    """
    if processed_mods is None:
        processed_mods = set()
    
    # Avoid processing the same mod twice (circular dependencies)
    if mod_id in processed_mods:
        return
    
    processed_mods.add(mod_id)

    # Prefix for dependency logging
    dep_prefix = "  [DEPENDENCY] " if is_dependency else ""
    
    try:
        project_data = modrinth_client.get_mod_project(mod_id)
        project_type = (project_data or {}).get("project_type", "mod")
        # Dependencies are almost always mods/libraries; keep them in the mods folder.
        target_directory = resolve_target_directory(
            project_type,
            mods_directory,
            resourcepacks_directory,
            is_dependency=is_dependency,
        )
        if not validate_directory(target_directory):
            return

        existing_mod = existing_mods.get(mod_id)

        # Early skip - no need to fetch mod name
        if not update and existing_mod:
            if is_dependency:
                mod_name = get_mod_name(modrinth_client, mod_id, project_data)
                mod_display = f"{mod_name} ({mod_id})" if mod_name != mod_id else mod_id
                print(f"{dep_prefix}SKIP: {mod_display} already exists (use -u/--update to update)")
            else:
                print(f"SKIP: {mod_id} already exists (use -u/--update to update)")
            stats["skipped"] += 1
            if is_dependency:
                stats["deps_skipped"] = stats.get("deps_skipped", 0) + 1
            else:
                stats["main_skipped"] = stats.get("main_skipped", 0) + 1
            # Still process dependencies even if mod is skipped
            latest_mod = get_latest_version(
                modrinth_client, mod_id, version, loader, project_type
            )
            if latest_mod:
                _process_dependencies(
                    latest_mod,
                    modrinth_client,
                    mods_directory,
                    resourcepacks_directory,
                    version,
                    loader,
                    update,
                    existing_mods,
                    stats,
                    failed_mods,
                    processed_mods,
                    mod_id,
                )
            return

        latest_mod = get_latest_version(
            modrinth_client, mod_id, version, loader, project_type
        )
        # import json
        # print("=" * 50)
        # print(f"existing_mod: {existing_mod}, latest_mod: {json.dumps(latest_mod)}")
        # print("=" * 50)
        if not latest_mod:
            # Error case - fetch mod name for better error message
            mod_name = get_mod_name(modrinth_client, mod_id, project_data)
            mod_display = f"{mod_name} ({mod_id})" if mod_name != mod_id else mod_id
            error_msg = f"{dep_prefix}ERROR: No version found for {mod_display} with MC_VERSION={version} and LOADER={loader}"
            if is_dependency and parent_mod_id:
                error_msg += f" (required by {parent_mod_id})"
            print(error_msg)
            stats["failed"] += 1
            if is_dependency:
                stats["deps_failed"] = stats.get("deps_failed", 0) + 1
            else:
                stats["main_failed"] = stats.get("main_failed", 0) + 1
            failed_mods.append(mod_display)
            return

        # Process dependencies first (before downloading the mod itself)
        if not is_dependency:  # Only log dependency processing for main mods
            dependencies = latest_mod.get("dependencies", [])
            required_deps = [dep for dep in dependencies if dep.get("dependency_type") == "required"]
            if required_deps:
                mod_name = get_mod_name(modrinth_client, mod_id, project_data)
                mod_display = f"{mod_name} ({mod_id})" if mod_name != mod_id else mod_id
                print(f"Processing {len(required_deps)} required dependency(ies) for {mod_display}...")
        
        _process_dependencies(
            latest_mod,
            modrinth_client,
            mods_directory,
            resourcepacks_directory,
            version,
            loader,
            update,
            existing_mods,
            stats,
            failed_mods,
            processed_mods,
            mod_id,
        )

        # Find primary file
        file_to_download: Optional[dict] = next(
            (file for file in latest_mod.get("files", []) if file.get("primary")), None
        )
        if not file_to_download:
            # Error case - fetch mod name for better error message
            mod_name = get_mod_name(modrinth_client, mod_id, project_data)
            mod_display = f"{mod_name} ({mod_id})" if mod_name != mod_id else mod_id
            print(f"{dep_prefix}ERROR: Couldn't find a primary file to download for {mod_display}")
            stats["failed"] += 1
            if is_dependency:
                stats["deps_failed"] = stats.get("deps_failed", 0) + 1
            else:
                stats["main_failed"] = stats.get("main_failed", 0) + 1
            failed_mods.append(mod_display)
            return

        filename: str = file_to_download["filename"]
        filename_parts = filename.split(".")
        filename_parts.insert(-1, mod_id)
        filename_with_id = ".".join(filename_parts)
        file_path = os.path.join(target_directory, filename_with_id)

        # Skip if already at latest version in the correct directory
        if existing_mod and existing_mod["filename"] == filename_with_id:
            existing_dir = os.path.abspath(
                existing_mod.get("directory", target_directory)
            )
            if existing_dir == os.path.abspath(target_directory):
                if is_dependency:
                    mod_name = get_mod_name(modrinth_client, mod_id, project_data)
                    mod_display = f"{mod_name} ({mod_id})" if mod_name != mod_id else mod_id
                    print(f"{dep_prefix}SKIP: {mod_display} ({filename_with_id}) latest version already exists")
                else:
                    print(f"SKIP: {mod_id} ({filename_with_id}) latest version already exists")
                stats["skipped"] += 1
                if is_dependency:
                    stats["deps_skipped"] = stats.get("deps_skipped", 0) + 1
                else:
                    stats["main_skipped"] = stats.get("main_skipped", 0) + 1
                return

            # Latest file lives in the wrong folder (e.g. pack previously saved under mods/)
            old_file_path = os.path.join(existing_dir, existing_mod["filename"])
            mod_name = get_mod_name(modrinth_client, mod_id, project_data)
            mod_display = f"{mod_name} ({mod_id})" if mod_name != mod_id else mod_id
            try:
                if os.path.exists(old_file_path):
                    shutil.move(old_file_path, file_path)
                    print(
                        f"{dep_prefix}MOVED: {mod_display} ({filename_with_id}) "
                        f"from {existing_dir} to {os.path.abspath(target_directory)}"
                    )
                    existing_mods[mod_id] = {
                        "id": mod_id,
                        "filename": filename_with_id,
                        "directory": os.path.abspath(target_directory),
                    }
                    stats["updated"] += 1
                    if is_dependency:
                        stats["deps_updated"] = stats.get("deps_updated", 0) + 1
                    else:
                        stats["main_updated"] = stats.get("main_updated", 0) + 1
                    return
            except OSError as e:
                print(
                    f"{dep_prefix}WARNING: Failed to move {existing_mod['filename']} "
                    f"for {mod_display}: {e}; will re-download"
                )
        
        # Also check if file exists on disk with same name (might have been downloaded as a dependency)
        # Only skip if it's the exact same version and we're not in update mode
        if os.path.exists(file_path) and not update:
            if is_dependency:
                mod_name = get_mod_name(modrinth_client, mod_id, project_data)
                mod_display = f"{mod_name} ({mod_id})" if mod_name != mod_id else mod_id
                print(f"{dep_prefix}SKIP: {mod_display} ({filename_with_id}) already exists on disk")
            else:
                print(f"SKIP: {mod_id} ({filename_with_id}) already exists on disk")
            stats["skipped"] += 1
            if is_dependency:
                stats["deps_skipped"] = stats.get("deps_skipped", 0) + 1
            else:
                stats["main_skipped"] = stats.get("main_skipped", 0) + 1
            return

        # We're actually downloading/updating - fetch mod name for display
        mod_name = get_mod_name(modrinth_client, mod_id, project_data)
        mod_display = f"{mod_name} ({mod_id})" if mod_name != mod_id else mod_id
        action = "UPDATING" if existing_mod else "DOWNLOADING"
        loaders_str = ", ".join(latest_mod.get("loaders", []))
        versions_str = ", ".join(latest_mod.get("game_versions", []))
        if is_dependency and parent_mod_id:
            parent_name = get_mod_name(modrinth_client, parent_mod_id)
            parent_display = f"{parent_name} ({parent_mod_id})" if parent_name != parent_mod_id else parent_mod_id
            print(
                f"{dep_prefix}{action}: {mod_display} - {file_to_download['filename']} "
                f"(required by {parent_display}, loaders: {loaders_str}, versions: {versions_str})"
            )
        else:
            print(
                f"{dep_prefix}{action}: {mod_display} - {file_to_download['filename']} "
                f"(loaders: {loaders_str}, versions: {versions_str})"
            )

        # Download the file
        download_success = modrinth_client.download_file(
            file_to_download["url"], file_path
        )

        if not download_success:
            print(f"{dep_prefix}ERROR: Failed to download {mod_display}")
            stats["failed"] += 1
            if is_dependency:
                stats["deps_failed"] = stats.get("deps_failed", 0) + 1
            else:
                stats["main_failed"] = stats.get("main_failed", 0) + 1
            failed_mods.append(mod_display)
            return

        # Only remove old file if download succeeded (from wherever it previously lived)
        if existing_mod:
            old_dir = existing_mod.get("directory", target_directory)
            old_file_path = os.path.join(old_dir, existing_mod["filename"])
            try:
                if os.path.exists(old_file_path) and os.path.abspath(old_file_path) != os.path.abspath(file_path):
                    os.remove(old_file_path)
                    print(f"{dep_prefix}REMOVED: Previous version {existing_mod['filename']} for {mod_display}")
            except OSError as e:
                print(f"{dep_prefix}WARNING: Failed to remove old file {existing_mod['filename']} for {mod_display}: {e}")

        existing_mods[mod_id] = {
            "id": mod_id,
            "filename": filename_with_id,
            "directory": os.path.abspath(target_directory),
        }

        stats["downloaded"] += 1
        if is_dependency:
            stats["deps_downloaded"] = stats.get("deps_downloaded", 0) + 1
        else:
            stats["main_downloaded"] = stats.get("main_downloaded", 0) + 1
        if existing_mod:
            stats["updated"] += 1
            if is_dependency:
                stats["deps_updated"] = stats.get("deps_updated", 0) + 1
            else:
                stats["main_updated"] = stats.get("main_updated", 0) + 1

    except Exception as e:
        # Error case - fetch mod name for better error message
        try:
            mod_name = get_mod_name(modrinth_client, mod_id)
            error_mod_display = f"{mod_name} ({mod_id})" if mod_name != mod_id else mod_id
        except:
            error_mod_display = mod_id
        print(f"{dep_prefix}ERROR: Failed to process {error_mod_display}: {e}")
        stats["failed"] += 1
        if is_dependency:
            stats["deps_failed"] = stats.get("deps_failed", 0) + 1
        else:
            stats["main_failed"] = stats.get("main_failed", 0) + 1
        failed_mods.append(error_mod_display)


def _process_dependencies(
    latest_mod: dict,
    modrinth_client: ModrinthClient,
    mods_directory: str,
    resourcepacks_directory: str,
    version: str,
    loader: str,
    update: bool,
    existing_mods: Dict[str, Dict[str, str]],
    stats: Dict[str, int],
    failed_mods: List[str],
    processed_mods: set,
    parent_mod_id: str,
) -> None:
    """Process required dependencies for a mod version.
    
    Downloads/updates all required dependencies recursively.
    
    Args:
        parent_mod_id: ID of the parent mod that requires these dependencies.
    """
    dependencies = latest_mod.get("dependencies", [])
    required_deps = [
        dep for dep in dependencies
        if dep.get("dependency_type") == "required"
    ]
    
    if not required_deps:
        return
    
    for dep in required_deps:
        dep_project_id = dep.get("project_id")
        if not dep_project_id:
            continue
        
        # Recursively download the dependency (always into the mods directory path)
        download_mod(
            dep_project_id,
            modrinth_client,
            mods_directory,
            resourcepacks_directory,
            version,
            loader,
            update,
            existing_mods,
            stats,
            failed_mods,
            processed_mods,
            is_dependency=True,
            parent_mod_id=parent_mod_id,
        )


def main():
    """Main entry point."""
    args = parse_args()

    # Validate and create mods directory (resourcepacks is created on demand)
    if not validate_directory(args.directory):
        return

    # Validate required inputs (should not be empty after prompting)
    if not args.collection or not args.version or not args.loader:
        print("ERROR: Collection ID, version, and loader are required")
        return

    modrinth_client = ModrinthClient()

    # Get collection details
    collection_details = modrinth_client.get_collection(args.collection)
    if not collection_details:
        print(f"ERROR: Collection id={args.collection} not found or inaccessible")
        return

    mods: List[str] = collection_details.get("projects", [])
    if not mods:
        print(f"WARNING: Collection {args.collection} contains no mods")
        return

    print(f"Found {len(mods)} mod(s) in collection")
    existing_mods = merge_existing_mods(args.directory, args.resourcepacks_directory)

    # Statistics tracking
    stats = {
        "downloaded": 0,
        "updated": 0,
        "skipped": 0,
        "failed": 0,
    }
    failed_mods: List[str] = []

    # Download mods in parallel
    max_workers = 5  # Reasonable default for concurrent downloads
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(
                download_mod,
                mod_id,
                modrinth_client,
                args.directory,
                args.resourcepacks_directory,
                args.version,
                args.loader,
                args.update,
                existing_mods,
                stats,
                failed_mods,
            )
            for mod_id in mods
        ]
        # Wait for all downloads to complete
        for future in futures:
            future.result()

    # Print summary
    print("\n" + "=" * 50)
    print("SUMMARY")
    print("=" * 50)
    
    # Main mods statistics
    main_downloaded = stats.get('main_downloaded', 0)
    main_updated = stats.get('main_updated', 0)
    main_skipped = stats.get('main_skipped', 0)
    main_failed = stats.get('main_failed', 0)
    
    print(f"\nMain Mods (from collection):")
    print(f"  Total mods in collection: {len(mods)}")
    print(f"  Downloaded: {main_downloaded}")
    if main_updated > 0:
        print(f"  Updated: {main_updated}")
    print(f"  Skipped: {main_skipped}")
    print(f"  Failed: {main_failed}")
    
    # Dependencies statistics
    deps_downloaded = stats.get('deps_downloaded', 0)
    deps_updated = stats.get('deps_updated', 0)
    deps_skipped = stats.get('deps_skipped', 0)
    deps_failed = stats.get('deps_failed', 0)
    total_deps = deps_downloaded + deps_updated + deps_skipped + deps_failed
    
    if total_deps > 0:
        print(f"\nDependencies (required by mods):")
        print(f"  Total dependencies processed: {total_deps}")
        print(f"  Downloaded: {deps_downloaded}")
        if deps_updated > 0:
            print(f"  Updated: {deps_updated}")
        print(f"  Skipped: {deps_skipped}")
        print(f"  Failed: {deps_failed}")
    
    # Overall totals
    print(f"\nOverall Totals:")
    print(f"  Total mods and dependencies processed: {stats['downloaded'] + stats['skipped'] + stats['failed']}")
    print(f"  Downloaded: {stats['downloaded']}")
    if stats["updated"] > 0:
        print(f"  Updated: {stats['updated']}")
    print(f"  Skipped: {stats['skipped']}")
    print(f"  Failed: {stats['failed']}")
    
    if failed_mods:
        print("\nFailed mods:")
        for mod in failed_mods:
            print(f"  - {mod}")
    print("=" * 50)


if __name__ == "__main__":
    main()
