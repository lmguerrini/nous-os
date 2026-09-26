"""Deterministic text projection for NousOS derived schema version 2.

Only explicit reader-facing payload fields are indexed. Top-level headers,
payload metadata, attachment identifiers, and JSON object keys are excluded.
Non-JSON canon remains searchable as ordinary UTF-8 text.
"""

from __future__ import annotations

import json
import re
import unicodedata


def _path(value: object, *keys: str) -> object:
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _strings(value: object):
    """Yield only string leaves; never emit dict keys or scalar metadata."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)


def project(body: str) -> str:
    """Return NFC text with all line and selected field boundaries as spaces."""
    try:
        record = json.loads(body)
    except json.JSONDecodeError:
        record = body
    if not isinstance(record, dict):
        values = [record] if isinstance(record, str) else []
    else:
        payload = record.get("payload")
        kind = record.get("kind")
        provider = record.get("provider")
        values: list[object] = []
        if kind == "message" and provider == "chatgpt.com":
            # Text and multimodal text use parts; recaps and thoughts have
            # separate prose fields. Tool and web-result metadata stay out.
            parts = _path(payload, "content", "parts")
            if isinstance(parts, list):
                values.extend(part if isinstance(part, str) else part.get("text")
                              for part in parts if isinstance(part, (str, dict)))
            values.append(_path(payload, "content", "content"))
            thoughts = _path(payload, "content", "thoughts")
            if isinstance(thoughts, list):
                for thought in thoughts:
                    if isinstance(thought, dict):
                        values.extend((thought.get("content"), thought.get("summary")))
                        chunks = thought.get("chunks")
                        if isinstance(chunks, list):
                            values.extend(chunk if isinstance(chunk, str) else chunk.get("text")
                                          for chunk in chunks if isinstance(chunk, (str, dict)))
        elif kind == "message" and provider == "claude.ai":
            item = _path(payload, "record")
            values.append(_path(item, "text"))
            blocks = _path(item, "content")
            if isinstance(blocks, list):
                for block in blocks:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text":
                        values.append(block.get("text"))
                    elif block.get("type") == "thinking":
                        values.extend((block.get("thinking"), block.get("summaries")))
        elif kind == "design_message":
            values.append(_path(payload, "record", "content", "content"))
            blocks = _path(payload, "record", "content", "contentBlocks")
            if isinstance(blocks, list):
                values.extend(block.get("text") for block in blocks if isinstance(block, dict))
            attachments = _path(payload, "record", "content", "attachments")
            if isinstance(attachments, list):
                values.extend(a.get("content") for a in attachments if isinstance(a, dict))
        elif kind in ("conversation", "design_conversation"):
            values.extend((_path(payload, "title"), _path(payload, "record", "name"),
                           _path(payload, "record", "title"), _path(payload, "record", "summary")))
        elif kind == "asset":
            # Current asset records have no extracted text; reserve explicit slots.
            values.extend((_path(payload, "extracted_text"), _path(payload, "text")))
        elif kind == "captured_message":
            values.extend((_path(payload, "text"), _path(payload, "text_content")))
        elif kind == "capture_window":
            buttons = _path(payload, "buttons")
            if isinstance(buttons, list):
                values.extend(button.get("label") for button in buttons if isinstance(button, dict))
        elif kind in ("document", "memory_file", "project_document"):
            values.extend((_path(payload, "text"), _path(payload, "record", "content")))
        elif kind == "memory_summary":
            values.append(_path(payload, "record", "conversations_memory"))
        elif kind == "project":
            values.extend((_path(payload, "record", "name"),
                           _path(payload, "record", "description"),
                           _path(payload, "record", "prompt_template")))
        elif kind == "reflection":
            content = _path(payload, "record", "content")
            if isinstance(content, dict):
                for key in ("hero_title", "hero_body", "about_your_time",
                            "expanding_your_skills", "topics", "worth_thinking_about"):
                    values.append(content.get(key))
    chunks = []
    for value in values:
        for leaf in _strings(value):
            normalized = re.sub(r"\s+", " ", unicodedata.normalize("NFC", leaf)).strip()
            if normalized and (not chunks or chunks[-1] != normalized):
                chunks.append(normalized)
    return " ".join(chunks)
