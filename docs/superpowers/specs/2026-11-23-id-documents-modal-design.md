# ID Documents modal — redesign (2026-11-23)

## Intent / why
The classic "ID Documents" viewer is a dark, image-only lightbox. The owner wants it
to (a) match the app's light grey/white palette, and (b) surface and let staff **edit**
the ID details the OCR now extracts (type, number, DOB, year, name) with an audit trail.

## Goals
- Light modal on the app palette (cobalt accents), **fixed size** — a card-shaped ID
  and a full-page ID both fit the same box without the modal resizing.
- Right pane: **one compact "Guest details" block** combining everyone on file
  (mobile once, then per-document: name, ID type, ID number, DOB + age + year).
- Each field editable; an **edit mark** on any field that was changed, and **hover**
  reveals the edit detail (who, when, previous value). No separate activity section.
- Left: photo + thumbnails to switch which document image is shown.

## Non-goals / decisions
- **No "primary ID" / "use for billing".** Billing & search use mobile + name only
  (owner), so no ID number is designated primary. (Model B: each document's fields are
  edited and stored independently.)
- No money/tax path touched. Preserved logic unchanged.
- Classic screens that open the viewer keep the same `openPhotoViewer(urls, idx, mobile)`
  entry point.

## Approach (chosen)
Store the editable fields **on the `id_docs` record** (`customers/{mobile}/id_docs/{doc_id}`):
`guest_name, id_type, id_number, dob, birth_year`. That record already carries
permissions, `captured_by`, and an append-only `history` — so edits get who/when/old→new
for free, and the edit mark + hover history read straight from `history`.

- `services/id_docs.py`
  - `_public`: also expose the five fields.
  - `set_fields(mobile, doc_id, *, fields, user)` — validate, diff vs current, append one
    `history` entry **per changed field** (`action:"field_edited"`, `field`, note `old → new`),
    update the record. (Modeled on `set_side`.)
  - `set_ocr_fields(mobile, doc_id, fields)` — fill only blank fields from OCR, no history
    spam; never overwrites a manual edit.
- `routers/customer_docs.py`
  - `POST /{mobile}/id-docs/{doc_id}/fields` (permission `customer_doc.capture`, audit
    `customer_doc.relabel`).
- OCR wiring: `routes/customers.py::_maybe_extract_demographics` already runs OCR into
  `guest_demographics`; also call `id_docs.set_ocr_fields` for the same `iddoc:{id}`.

## Frontend
`templates/index.html` (`#doc-photo-viewer` markup + styles) and `static/customer-docs.js`:
- Rebuild the modal light + fixed-size; image stage = fixed box, `object-fit: contain`.
- `openPhotoViewer` fetches `GET /api/v2/customers/{mobile}/id-docs` when a mobile is
  present, matches each image URL's doc_id to a record, renders the combined block.
- Age computed in JS from `birth_year` (fallback `dob`).
- Edit → `POST …/fields`; edit mark + hover tooltip from each record's `history`
  (`action:"field_edited"` entries, keyed by `field`).

## Left to the builder
- Exact field labels/spacing (match `.table-erp` tone).
- Which permission shows the Edit button (reuse `can.capture`).
