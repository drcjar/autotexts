# Respiratory Autotexts

Ready-to-paste text blocks for the respiratory clinic — consultation templates, patient
information, test explainers, results layouts and letters — each one showing the guideline or
trial it rests on.

Sister site to [respiratorytrials.org](https://respiratorytrials.org), and built the same way:
plain YAML, a Python script, no database, no server, no npm.

## Where it came from

In April 2024 Dr Angshu Bhowmik sent a new registrar at the Homerton the auto-texts he used with
his dictation software, with a note saying they were by no means perfect, that he changed them
from time to time, and that if we all helped each other out with good examples of letters this
might be a good thing.

His originals are the seed — the clerking skeleton, the bronchiectasis advice, the sputum
collection instructions, the non-attendance and discharge letters. What has been added is the
sourcing: every clinical block names the national or international guideline behind it, and where
a specific trial is the reason a sentence says what it says, that trial links to its record on
respiratorytrials.org.

## How it works

```
build.py                 generate site/ from data/ + templates/
validate.py              schema, referential integrity and paste-safety checks — CI gates on this
sitelib.py               shared loading, field parsing and defaulting
data/site.yaml           topics, kinds, navigation
data/autotexts/          one YAML file per block, filed by topic
data/local/              organisation-specific overlays (delete the directory to remove them all)
data/trials_index.json   acronym -> slug cache from respiratorytrials.org
templates/               Jinja2 templates
static/                  CSS, JS, favicon
tools/sync_trials.py     rebuild the trial index from a local respiratorytrials checkout
```

```bash
pip install -r requirements.txt
python3 validate.py && python3 build.py
python3 -m http.server -d site 8000
```

## The paste block

Square brackets are fields, left empty on purpose. The convention is Angshu's: Dragon's "Manage
auto-texts" treats `[]` as a stop you jump between with F1 and F2. Where the line does not make it
obvious what goes in the field, the hint is written inside the brackets — it is a prompt to the
person dictating and is copied along with everything else.

What the copy button puts on the clipboard is exactly the plain text in the YAML. The field
highlighting is a `<span>` around the brackets, so `textContent` is byte-identical to the source;
no citations, no attribution line, no formatting travel with it. The evidence panel is deliberately
outside the block.

## Adding a block

```yaml
title: New asthma patient
topic: asthma          # must exist in data/site.yaml
kind: consultation     # consultation | patient-info | test-info | results | letter | admin
summary: One line, shown on cards and in search.
updated: 2026-08-06    # validate warns after 18 months
body: |
  The text that gets pasted. Plain text only.
  Smoking status: []
variants:              # optional: a shorter or alternative form of the same block
  - title: ...
    body: |
      ...
notes: >-              # editorial: how to use it, and why it says what it says.
  Supports **bold** and [[TRIAL]] links.
evidence:
  - name: NICE NG245
    url: https://www.nice.org.uk/guidance/ng245
    note: What this guideline actually says that the block depends on.
trials: [SYGMA 1]      # must exist on respiratorytrials.org
see_also: [asthma-review]
```

`validate.py` fails the build on an unknown topic or kind, a duplicate slug, a trial or `see_also`
that does not exist, an evidence entry with no name, unbalanced brackets, a tab, markdown that has
crept into a paste block, or a smart quote — curly quotes and en dashes arrive in many EPRs as
replacement characters, so they are an error rather than a style preference. It warns on a clinical
block with no evidence cited, and on anything not reviewed for 18 months.

## The local layer

`data/local/*.yaml` holds organisation-specific blocks: phone numbers, booking systems, where to
drop a sample. They are facts about a building rather than about medicine, they go out of date
faster than anything else here, and they render on their own pages with a warning saying so.

Delete `data/local/` and every organisation-specific detail leaves the site in one step. Forking
this for another trust means rewriting that one directory.

## Caveats

Templates, not decisions. Nothing here is approved by any trust, college or society. A template
makes it easy to write a fluent letter about a consultation that did not happen; that risk comes
with the time it saves.

The site holds no patient data and asks for none — you copy from it, and the filling in happens in
your own record system.

Blocks go out of date the moment a guideline moves. Corrections are the most useful thing you can
send.
