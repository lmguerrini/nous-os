/**
 * Smoke check (not a proof) that the synthetic KB text stays invented: none of the
 * deny-list words may occur in any generated text. The list is deliberately small and
 * generic: common first names plus a few product names. The generator builds text only
 * from invented syllables, so any hit would mean a real word slipped through.
 */
import { ok } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { generateSyntheticKb } from "../src/synthetic-kb.ts";

const DENY_LIST = [
  "chatgpt", "claude", "openai", "gemini",
  "anna", "maria", "john", "luca", "marco", "emma", "sara", "david", "michael",
  "julia", "laura", "paul", "peter", "thomas", "nina", "lena", "sofia", "noah",
];

function allText(kb: ReturnType<typeof generateSyntheticKb>): string {
  const parts: string[] = [];
  for (const node of kb.nodes) {
    parts.push(node.title ?? "", node.short_label ?? "", node.statement ?? "", node.file_name ?? "", node.provider ?? "");
    for (const item of node.evidence ?? []) parts.push(item.span);
    for (const item of node.spans ?? []) parts.push(item.span);
    for (const citation of node.citations ?? []) parts.push(citation.span);
  }
  for (const relation of kb.relations) {
    parts.push(relation.explanation ?? "");
    for (const citation of relation.evidence) parts.push(citation.span);
    for (const citation of relation.counter_evidence ?? []) parts.push(citation.span);
  }
  for (const passage of kb.passages) {
    parts.push(passage.citation.span, passage.context_before ?? "", passage.context_after ?? "");
  }
  return parts.join("\n").toLowerCase();
}

test("no deny-listed word occurs in the generated text (both profiles, several seeds)", () => {
  for (const profile of ["small", "reference"] as const) {
    for (const seed of [1, 2, 3]) {
      const text = allText(generateSyntheticKb(profile, seed));
      for (const word of DENY_LIST) {
        ok(!new RegExp(`\\b${word}\\b`).test(text), `${profile} seed ${seed} contains "${word}"`);
      }
    }
  }
});

test("the stored small fixture is equally clean", async () => {
  const kb = JSON.parse(await readFile(new URL("../fixtures/kb-small.json", import.meta.url), "utf8"));
  const text = allText(kb);
  for (const word of DENY_LIST) {
    ok(!new RegExp(`\\b${word}\\b`).test(text), `fixtures/kb-small.json contains "${word}"`);
  }
});

test("dates stay within 2024-2026 and digests are hex", () => {
  const kb = generateSyntheticKb("small", 1);
  const dates = [
    ...kb.nodes.map(node => node.date).filter(Boolean),
    ...kb.passages.map(passage => passage.record.date),
  ] as string[];
  ok(dates.length > 0);
  for (const date of dates) {
    ok(/^\d{4}-\d{2}-\d{2}$/.test(date), `malformed date ${date}`);
    const year = Number(date.slice(0, 4));
    ok(year >= 2024 && year <= 2026, `date ${date} outside 2024-2026`);
  }
  for (const passage of kb.passages) {
    ok(/^[0-9a-f]{64}$/.test(passage.citation.snapshot_digest));
    ok(passage.citation.start_byte < passage.citation.end_byte);
  }
});
