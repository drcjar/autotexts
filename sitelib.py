"""Shared loading, defaulting and text handling.

Imported by build.py and validate.py so the two can never disagree about what
the data means.
"""

import json
import pathlib
import re

import yaml

ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data"
SITE_YAML = DATA / "site.yaml"
AUTOTEXTS_DIR = DATA / "autotexts"
TRIALS_INDEX = DATA / "trials_index.json"
LOCAL_DIR = DATA / "local"

# Fields an autotext record may carry. Only title, topic, kind, summary and
# body are required; everything else renders when present and is skipped when
# not, so a thin record is still a useful record.
FIELDS = [
    "title",
    "topic",
    "kind",
    "summary",
    "body",
    "notes",
    "evidence",
    "trials",
    "local",
    "variants",
    "credit",
    "updated",
    "see_also",
]

REQUIRED = ["title", "topic", "kind", "summary", "body"]

# A field is an empty pair of brackets, or brackets around a short hint. The
# hint is part of the pasted text — it is a prompt to the person dictating, not
# markup — so it is preserved verbatim on copy and only styled in the browser.
FIELD_RE = re.compile(r"\[[^\[\]\n]{0,60}\]")


def slugify(value):
    value = re.sub(r"[^\w\s-]", "", str(value).lower())
    return re.sub(r"[\s_-]+", "-", value).strip("-")


class DataError(Exception):
    """A YAML file that cannot be read. Raised with the path, because the
    traceback from PyYAML alone does not say which of a hundred files it was."""


def read_yaml(path):
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f" (line {mark.line + 1})" if mark else ""
        raise DataError(f"{path}{where}: {getattr(exc, 'problem', exc)}") from None


def load_json(path, default=None):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {} if default is None else default


def load_site():
    """Site config with optional keys filled in.

    Templates run under StrictUndefined, so every key a template touches must
    exist. Defaulting here keeps site.yaml free of boilerplate.
    """
    site = read_yaml(SITE_YAML)
    for topic in site["topics"]:
        topic.setdefault("short", topic["name"])
        topic.setdefault("blurb", "")
        topic.setdefault("guidelines", [])
    for kind in site["kinds"]:
        kind.setdefault("blurb", "")
        kind.setdefault("verb", "")
    return site


def load_autotexts():
    """Every autotext YAML, in title order within a topic."""
    records = []
    for path in sorted(AUTOTEXTS_DIR.rglob("*.yaml")):
        record = read_yaml(path)
        if not record:
            continue
        record["_path"] = str(path.relative_to(ROOT))
        record["slug"] = record.get("slug") or path.stem
        for field in FIELDS:
            record.setdefault(field, None)
        record["evidence"] = record["evidence"] or []
        record["trials"] = record["trials"] or []
        record["see_also"] = record["see_also"] or []
        record["variants"] = record["variants"] or []
        record["body"] = normalise_body(record.get("body") or "")
        for variant in record["variants"]:
            variant["body"] = normalise_body(variant.get("body") or "")
            variant.setdefault("note", "")
        records.append(record)
    records.sort(key=lambda r: (r["topic"], r["title"]))
    return records


def load_local_layers():
    """Site-specific overlays, one YAML per organisation.

    Kept in their own directory and their own records so that a trust wanting a
    public copy of this site can delete data/local/ and lose nothing else.
    """
    layers = {}
    if not LOCAL_DIR.exists():
        return layers
    for path in sorted(LOCAL_DIR.glob("*.yaml")):
        data = read_yaml(path) or {}
        data["slug"] = data.get("slug") or path.stem
        data["_path"] = str(path.relative_to(ROOT))
        for block in data.get("blocks", []):
            block["body"] = normalise_body(block.get("body") or "")
            block.setdefault("note", "")
            block.setdefault("slug", slugify(block["title"]))
        layers[data["slug"]] = data
    return layers


def normalise_body(text):
    """Strip trailing whitespace per line and collapse the outer blank lines.

    What gets pasted into an EPR should not carry invisible trailing spaces or
    a leading blank line, because both survive the paste and neither is visible
    in the YAML.
    """
    lines = [line.rstrip() for line in str(text).replace("\r\n", "\n").split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def count_fields(text):
    return len(FIELD_RE.findall(text or ""))


def field_labels(text, limit=40):
    """Name every field in the order Dragon would walk it with F1 and F2.

    A field is rarely self-describing: most of Angshu's are a bare `[]` sitting
    after a label ("Smoking status: []") or under a heading ("Impression:" then
    the field on its own line). The label the person dictating actually needs is
    the one to the left of the brackets, so that wins; the hint inside the
    brackets is the fallback for a field that stands alone at the start of a
    line, and the nearest preceding line is the fallback after that.
    """
    labels = []
    previous = ""
    for line in str(text).split("\n"):
        matches = list(FIELD_RE.finditer(line))
        if not matches:
            if line.strip():
                previous = line.strip()
            continue
        for index, match in enumerate(matches):
            hint = match.group(0)[1:-1].strip()
            start = matches[index - 1].end() if index else 0
            raw = line[start:match.start()].rstrip()
            before = raw.strip(" \t-:;,()")
            label = before or hint or previous
            label = " ".join(str(label).split()).rstrip(":").strip()
            if len(label) > limit:
                label = label[:limit].rstrip() + "…"
            # A field is confidently named when something declares it: a label
            # ending in a colon, a hint written inside the brackets, or a
            # heading on the line above when the field sits alone. Words that
            # merely precede it in a sentence - "prednisolone [] mg" - do not.
            named = bool(hint) or raw.endswith(":") or (not raw and previous.endswith(":"))
            labels.append({"label": label or "value", "named": named})
        if line.strip():
            previous = line.strip()
    return labels


# Kinds whose fields sit one to a labelled line, which is what makes a list of
# them meaningful. Prose kinds embed fields in sentences - "prednisolone [] mg
# once a day" - where the neighbouring words name a drug rather than the field,
# and a list of those reads as nonsense.
STRUCTURED_KINDS = {"consultation", "results", "admin"}

# Even in a structured block, if most fields turn out to be unlabelled the strip
# is guesswork dressed as an index, and a wrong list of what a block will ask
# for is worse than no list at all.
NAMED_ENOUGH = 0.5


def field_strip(text, kind):
    """Field names to show above a block, or [] when they cannot be trusted."""
    if kind not in STRUCTURED_KINDS:
        return []
    labels = field_labels(text)
    if not labels:
        return []
    if sum(1 for item in labels if item["named"]) / len(labels) < NAMED_ENOUGH:
        return []
    return [item["label"] for item in labels]


def search_haystack(record, topic_name, kind_name):
    """Everything a search query may legitimately match against."""
    parts = [
        record["title"],
        record["summary"],
        topic_name,
        kind_name,
        record.get("notes") or "",
        record["body"],
    ]
    for item in record["evidence"]:
        parts.append(item.get("name", ""))
    parts.extend(record["trials"])
    return " ".join(str(p) for p in parts)
