#!/usr/bin/env python3
"""Generate the static site into site/.

Usage:
    python3 build.py [--output site] [--base-url https://autotexts.respiratorytrials.org]
"""

import argparse
import datetime as dt
import html
import json
import pathlib
import re
import shutil
import sys

from jinja2 import Environment, FileSystemLoader, StrictUndefined

import sitelib as lib

ROOT = pathlib.Path(__file__).resolve().parent
TEMPLATES = ROOT / "templates"
STATIC = ROOT / "static"

INLINE_LINK = re.compile(r"\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]")
INLINE_BOLD = re.compile(r"\*\*(.+?)\*\*")


class BuildError(Exception):
    pass


FIELD_SPAN = re.compile(r'<span class="f">(\[[^<]*?\])</span>')


def render_body(text, context="body"):
    """Escape the paste block and mark its fields.

    The span is styling only: `textContent` still yields the bracket pair
    exactly as written, so what the copy button puts on the clipboard is
    byte-identical to the YAML.

    That is the site's one real promise, so it is checked here rather than
    assumed: the markup is reversed and compared with the input, and a build
    that would put anything else on someone's clipboard fails.
    """
    escaped = html.escape(text)
    marked = lib.FIELD_RE.sub(lambda m: f'<span class="f">{m.group(0)}</span>', escaped)

    round_trip = html.unescape(FIELD_SPAN.sub(r"\1", marked))
    if round_trip != text:
        raise BuildError(
            f"{context}: the rendered block does not copy back to its source. "
            f"Whatever the browser puts on the clipboard would not be the text in the YAML."
        )
    return marked


def render_prose(text, trials, context, trials_site):
    """Resolve the two markup rules used in editorial notes.

    [[ACRONYM]] or [[ACRONYM|label]] -> link to that trial on the sister site
    **text**                         -> <strong>

    An unknown acronym is a build error, so a note can never quietly point at a
    trial that is not on respiratorytrials.org.
    """
    escaped = html.escape(" ".join(str(text).split()))

    def link(match):
        acronym = match.group(1).strip()
        label = (match.group(2) or acronym).strip()
        trial = trials.get(acronym.upper())
        if trial is None:
            raise BuildError(f"{context}: [[{acronym}]] is not a trial on respiratorytrials.org")
        url = f"{trials_site}/trial/{trial['slug']}/"
        return f'<a class="trial-link" href="{url}" data-summary="{html.escape(trial["summary"])}">{label}</a>'

    return INLINE_BOLD.sub(r"<strong>\1</strong>", INLINE_LINK.sub(link, escaped))


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="site")
    parser.add_argument("--base-url", default=None)
    args = parser.parse_args()

    site = lib.load_site()
    if args.base_url:
        site["base_url"] = args.base_url.rstrip("/")
    trials_site = site["trials_site"].rstrip("/")

    trials = lib.load_json(lib.TRIALS_INDEX)
    records = lib.load_autotexts()
    layers = lib.load_local_layers()

    topics = {t["slug"]: t for t in site["topics"]}
    kinds = {k["slug"]: k for k in site["kinds"]}

    seen = {}
    for record in records:
        if record["topic"] not in topics:
            raise BuildError(f"{record['_path']}: unknown topic {record['topic']!r}")
        if record["kind"] not in kinds:
            raise BuildError(f"{record['_path']}: unknown kind {record['kind']!r}")
        if record["slug"] in seen:
            raise BuildError(f"duplicate slug {record['slug']}: {record['_path']} and {seen[record['slug']]}")
        seen[record["slug"]] = record["_path"]

    by_slug = {r["slug"]: r for r in records}

    for record in records:
        context = record["_path"]
        record["topic_name"] = topics[record["topic"]]["name"]
        record["kind_name"] = kinds[record["kind"]]["name"]
        record["body_html"] = render_body(record["body"], f"{context}:body")
        record["field_count"] = lib.count_fields(record["body"])
        record["field_labels"] = lib.field_strip(record["body"], record["kind"])
        record["word_count"] = lib.word_count(record["body"])
        record["notes_html"] = (
            render_prose(record["notes"], trials, f"{context}:notes", trials_site)
            if record["notes"] else ""
        )

        for variant in record["variants"]:
            variant["body_html"] = render_body(variant["body"], f"{context}:variant {variant['title']!r}")
            variant["field_count"] = lib.count_fields(variant["body"])
            variant["slug"] = variant.get("slug") or lib.slugify(variant["title"])

        for item in record["evidence"]:
            item.setdefault("url", "")
            item.setdefault("note", "")
            if item.get("note"):
                item["note_html"] = render_prose(
                    item["note"], trials, f"{context}:evidence", trials_site
                )

        resolved = []
        for acronym in record["trials"]:
            trial = trials.get(str(acronym).upper())
            if trial is None:
                raise BuildError(
                    f"{context}: trial {acronym!r} is not on respiratorytrials.org — "
                    f"run tools/sync_trials.py if it was added recently"
                )
            resolved.append({**trial, "url": f"{trials_site}/trial/{trial['slug']}/"})
        resolved.sort(key=lambda t: (-int(t["year"] or 0), t["acronym"]))
        record["resolved_trials"] = resolved

        related = []
        for slug in record["see_also"]:
            other = by_slug.get(slug)
            if other is None:
                raise BuildError(f"{context}: see_also {slug!r} is not an autotext")
            related.append(other)
        record["related"] = related

    # Local overlays are separate records so a trust can delete data/local/ and
    # lose nothing else. They carry no evidence panel: they are facts about a
    # building, not about medicine.
    for layer in layers.values():
        for block in layer.get("blocks", []):
            block["body_html"] = render_body(block["body"], f"{layer['_path']}:{block['title']!r}")
            block["field_count"] = lib.count_fields(block["body"])

    env = Environment(
        loader=FileSystemLoader(TEMPLATES),
        autoescape=True,
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )

    out = ROOT / args.output
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    built = dt.datetime.now(dt.timezone.utc)
    by_topic = {slug: [] for slug in topics}
    by_kind = {slug: [] for slug in kinds}
    for record in records:
        by_topic[record["topic"]].append(record)
        by_kind[record["kind"]].append(record)

    common = {
        "site": site,
        "groups": site["groups"],
        "topics": topics,
        "topic_list": site["topics"],
        "kinds": kinds,
        "kind_list": site["kinds"],
        "layers": sorted(layers.values(), key=lambda layer: layer["name"]),
        "built": built,
    }

    # The front page opens with a real block rather than a description of one.
    hero = by_slug.get(site.get("hero"))
    if site.get("hero") and hero is None:
        raise BuildError(f"site.yaml: hero {site['hero']!r} is not an autotext")

    write(
        out / "index.html",
        env.get_template("index.html").render(
            **common,
            hero=hero,
            records=records,
            by_topic=by_topic,
            by_kind=by_kind,
            total=len(records),
            page_title=site["title"],
            page_url="/",
        ),
    )

    for topic in site["topics"]:
        slug = topic["slug"]
        write(
            out / slug / "index.html",
            env.get_template("topic.html").render(
                **common,
                topic=topic,
                records=by_topic[slug],
                page_title=topic["name"],
                page_url=f"/{slug}/",
            ),
        )

    for kind in site["kinds"]:
        slug = kind["slug"]
        write(
            out / "kind" / slug / "index.html",
            env.get_template("kind.html").render(
                **common,
                kind=kind,
                records=by_kind[slug],
                page_title=kind["name"],
                page_url=f"/kind/{slug}/",
            ),
        )

    for record in records:
        write(
            out / "t" / record["slug"] / "index.html",
            env.get_template("autotext.html").render(
                **common,
                record=record,
                topic=topics[record["topic"]],
                kind=kinds[record["kind"]],
                page_title=record["title"],
                page_url=f"/t/{record['slug']}/",
            ),
        )

    for layer in layers.values():
        write(
            out / "local" / layer["slug"] / "index.html",
            env.get_template("local.html").render(
                **common,
                layer=layer,
                page_title=layer["name"],
                page_url=f"/local/{layer['slug']}/",
            ),
        )

    write(
        out / "about" / "index.html",
        env.get_template("about.html").render(
            **common, total=len(records), page_title="About", page_url="/about/",
        ),
    )
    write(
        out / "404.html",
        env.get_template("404.html").render(**common, page_title="Not found", page_url="/404.html"),
    )

    # --- search index -----------------------------------------------------
    # The body goes in: people search for a phrase they remember seeing in the
    # block ("pack years", "postural drainage"), not for its title.
    index = [
        {
            "s": r["slug"],
            "t": r["title"],
            "p": topics[r["topic"]]["name"],
            "k": kinds[r["kind"]]["name"],
            "d": r["summary"],
            "h": lib.search_haystack(r, topics[r["topic"]]["name"], kinds[r["kind"]]["name"]).lower(),
        }
        for r in records
    ]
    write(out / "autotexts.json", json.dumps(index, ensure_ascii=False, separators=(",", ":")))

    # Plain-text of every block, for anyone who would rather script against the
    # site than click it.
    write(
        out / "autotexts.txt",
        "\n\n".join(f"### {r['title']} [{r['slug']}]\n\n{r['body']}" for r in records) + "\n",
    )

    for item in STATIC.iterdir():
        target = out / "static" / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)

    if site.get("domain"):
        write(out / "CNAME", site["domain"] + "\n")

    pages = 1 + len(site["topics"]) + len(site["kinds"]) + len(records) + len(layers) + 2
    fields = sum(r["field_count"] for r in records)
    print(f"built {pages} pages into {out.relative_to(ROOT)}/")
    print(f"  {len(records)} autotexts, {fields} fields, {len(layers)} local overlay(s)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BuildError, lib.DataError) as exc:
        print(f"build error: {exc}", file=sys.stderr)
        raise SystemExit(1)
