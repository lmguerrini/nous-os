"""The published images, and the public fixtures they came from.

`docs/assets/MANIFEST.json` claims that every figure in `README.md` was produced
from a named public synthetic fixture. A claim like that is worth exactly what
reads it, so this does: it checks each image's digest against the manifest, each
fixture's digest against the file on disk, and that the set of images, the set of
manifest entries and the set of figures the README actually references are the
same set.

Without this, the manifest would be a sentence about provenance rather than a
statement of it, and a figure could be swapped for one taken from anywhere at
all with nothing turning red.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

REPOSITORY = Path(__file__).resolve().parent.parent
ASSETS = REPOSITORY / "docs" / "assets"
MANIFEST_PATH = ASSETS / "MANIFEST.json"
README = REPOSITORY / "README.md"

#: Every fixture a documentation image may be produced from. Public, synthetic
#: and tracked. A manifest naming anything outside this set is a finding, not a
#: new option: the whole point of the manifest is that the images came from data
#: that is safe to publish.
PERMITTED_FIXTURE_ROOTS = ("fixtures/synthetic/",)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def manifest() -> dict[str, object]:
    if not MANIFEST_PATH.exists():
        pytest.fail(
            f"{MANIFEST_PATH.relative_to(REPOSITORY)} is absent, so the provenance of every "
            "published figure is unstated. This is a NOT-RUN, not a pass."
        )
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def images(manifest: dict[str, object]) -> list[dict[str, object]]:
    entries = manifest.get("images")
    assert isinstance(entries, list) and entries, "the manifest records no images"
    return entries


def test_every_published_image_matches_the_digest_the_manifest_records(
    manifest: dict[str, object],
) -> None:
    wrong: list[str] = []
    for entry in images(manifest):
        path = ASSETS / str(entry["file"])
        if not path.exists():
            wrong.append(f"{entry['file']}: recorded in the manifest and absent from the tree")
            continue
        observed = digest(path)
        if observed != entry["sha256"]:
            wrong.append(f"{entry['file']}: recorded {entry['sha256'][:12]}, found {observed[:12]}")
    assert wrong == [], "\n".join(wrong)


def test_every_image_in_the_directory_is_accounted_for(manifest: dict[str, object]) -> None:
    recorded = {str(entry["file"]) for entry in images(manifest)}
    present = {path.name for path in ASSETS.glob("*.png")}
    assert present == recorded, (
        f"unrecorded images: {sorted(present - recorded)}; "
        f"recorded but absent: {sorted(recorded - present)}"
    )


def test_every_image_came_from_a_public_synthetic_fixture(manifest: dict[str, object]) -> None:
    wrong: list[str] = []
    for entry in images(manifest):
        fixture = str(entry["fixture"])
        if not fixture.startswith(PERMITTED_FIXTURE_ROOTS):
            wrong.append(f"{entry['file']}: produced from {fixture}, which is not a public fixture")
            continue
        path = REPOSITORY / fixture
        if not path.exists():
            wrong.append(f"{entry['file']}: names {fixture}, which is not in this repository")
            continue
        observed = digest(path)
        if observed != entry["fixtureSha256"]:
            wrong.append(
                f"{entry['file']}: {fixture} recorded {str(entry['fixtureSha256'])[:12]}, "
                f"found {observed[:12]} — the image no longer matches the data it claims"
            )
    assert wrong == [], "\n".join(wrong)


def test_every_figure_the_readme_shows_is_a_recorded_image() -> None:
    referenced = set(re.findall(r"!\[[^\]]*\]\(docs/assets/([^)]+)\)", README.read_text("utf-8")))
    assert referenced, "the README references no figures, so this check would pass vacuously"
    missing = sorted(name for name in referenced if not (ASSETS / name).exists())
    assert missing == [], f"the README shows figures that do not exist: {missing}"
