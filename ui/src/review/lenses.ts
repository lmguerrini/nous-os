export type ReadingMode = { id: string; label: string; kind: string; status: string; meaning: string; why_default: string; effect_on_data: string };
export type OtherMode = { id: string; label: string; available: boolean; meaning: string; reason: string };
export type RegisteredLens = { id: string; label: string; status: string; feedable: boolean; meaning: string; reason: string };
export type LensRegister = { schema: "nousos-review-lenses-1"; reading_mode: ReadingMode; other_modes: OtherMode[]; lenses: RegisteredLens[]; planned: { name: string; label: string; status: string }[]; not_lenses: string[]; sources: { repository: string; commit: string; evidence: string[] }[]; notice: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: Record<string, unknown>, keys: string[]) => keys.every((key) => typeof v[key] === "string");
const arrayOf = (v: unknown, test: (item: Record<string, unknown>) => boolean) => Array.isArray(v) && v.every((item: unknown) => object(item) && test(item));
export function parseLensRegister(value: unknown): LensRegister | null {
  if (!object(value) || value.schema !== "nousos-review-lenses-1" || !object(value.reading_mode) ||
      !strings(value.reading_mode, ["id", "label", "kind", "status", "meaning", "why_default", "effect_on_data"]) ||
      !arrayOf(value.other_modes, (v) => strings(v, ["id", "label", "meaning", "reason"]) && typeof v.available === "boolean") ||
      !arrayOf(value.lenses, (v) => strings(v, ["id", "label", "status", "meaning", "reason"]) && typeof v.feedable === "boolean") ||
      !arrayOf(value.planned, (v) => strings(v, ["name", "label", "status"])) ||
      !Array.isArray(value.not_lenses) || !value.not_lenses.every((item: unknown) => typeof item === "string") ||
      !arrayOf(value.sources, (v) => strings(v, ["repository", "commit"]) && Array.isArray(v.evidence) && v.evidence.every((item: unknown) => typeof item === "string")) ||
      typeof value.notice !== "string") return null;
  return value as LensRegister;
}
export async function fetchLenses(): Promise<LensRegister | null> {
  try { const response = await fetch("/api/lenses.json"); return response.ok ? parseLensRegister(await response.json()) : null; } catch { return null; }
}
export function renderLensPopover(host: HTMLElement, register: LensRegister | null): void {
  host.replaceChildren();
  const add = (tag: string, content: string, parent: HTMLElement = host) => { const el = document.createElement(tag); el.textContent = content; parent.append(el); return el; };
  if (!register) { add("p", "Registro delle lenti non fornito."); return; }
  const reading = register.reading_mode;
  add("h3", "Lettura attiva"); add("p", `${reading.label} · predefinita`); add("p", reading.meaning); add("p", `Perché predefinita: ${reading.why_default}`); add("p", `Effetto su questi dati: ${reading.effect_on_data}`);
  add("h3", "Altre modalità"); for (const mode of register.other_modes) add("p", `${mode.label} · non disponibile. ${mode.meaning} ${mode.reason}`);
  add("h3", "Lenti registrate"); for (const lens of register.lenses) add("p", `${lens.label} · non alimentabile. ${lens.meaning} ${lens.reason}`);
  add("h3", "Lenti previste"); for (const lens of register.planned) add("p", `${lens.label} · ${lens.status}`);
  add("h3", "Non sono lenti"); for (const note of register.not_lenses) add("p", note);
  add("h3", "Fonti"); for (const source of register.sources) add("p", `${source.repository} · ${source.commit} · ${source.evidence.join("; ")}`);
  add("p", register.notice);
}
