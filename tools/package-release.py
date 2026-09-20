"""Create the manifest and installable ZIP uploaded with each GitHub release."""

import argparse
import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist"
FILES = ("module.json", "README.md", "LICENSE")
DIRECTORIES = ("scripts", "styles", "assets", "packs/zone-effects")
EXCLUDED_PACK_FILES = {"LOCK", "LOG", "LOG.old"}


def package(tag: str | None) -> Path:
    manifest_path = ROOT / "module.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError(f"Release version must be x.y.z: {version}")
    expected_tag = f"v{version}"
    if tag is not None and tag != expected_tag:
        raise ValueError(f"Tag {tag} does not match module version {expected_tag}")

    repository = manifest["url"].rstrip("/")
    expected_manifest = f"{repository}/releases/latest/download/module.json"
    expected_download = f"{repository}/releases/download/{expected_tag}/module.zip"
    if manifest.get("manifest") != expected_manifest:
        raise ValueError(f"Manifest URL must be {expected_manifest}")
    if manifest.get("download") != expected_download:
        raise ValueError(f"Download URL must be {expected_download}")

    sources = []
    for name in FILES:
        source = ROOT / name
        if not source.is_file():
            raise FileNotFoundError(source)
        sources.append(source)
    for name in DIRECTORIES:
        directory = ROOT / name
        if not directory.is_dir():
            raise FileNotFoundError(directory)
        for source in sorted(directory.rglob("*")):
            if source.is_file() and not (
                name == "packs/zone-effects" and source.name in EXCLUDED_PACK_FILES
            ):
                sources.append(source)

    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / "module.json").write_bytes(manifest_path.read_bytes())
    archive = OUTPUT / "module.zip"
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as zip_file:
        for source in sources:
            zip_file.write(source, source.relative_to(ROOT).as_posix())
    with ZipFile(archive) as zip_file:
        bad_member = zip_file.testzip()
        if bad_member:
            raise ValueError(f"Corrupt ZIP member: {bad_member}")
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Git tag being released, such as v0.1.0")
    args = parser.parse_args()
    print(package(args.tag))
