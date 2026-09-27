/** D-065 review convention, separate from epistemic modes and lenses. */
export const EVIDENCE_HELP =
  "Convenzione provvisoria della revisione D-065; non è un modello epistemico e non è una lente.";
export const EVIDENCE_STATE = {
  A: "Dichiarazione esplicita del fondatore",
  B: "Conseguenza diretta sostenuta dal canone",
  C: "Interpretazione forte non approvata",
  D: "Analogia o ipotesi creativa",
} as const;
export type EvidenceClass = keyof typeof EVIDENCE_STATE;
/** Keep unknown evidence codes readable without claiming a meaning the register does not supply. */
export function evidenceDescription(value: string): string {
  return value in EVIDENCE_STATE
    ? `${value} · ${EVIDENCE_STATE[value as EvidenceClass]}. ${EVIDENCE_HELP}`
    : EVIDENCE_HELP;
}
