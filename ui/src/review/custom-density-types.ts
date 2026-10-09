// D086-CUSTOM BEGIN: the shell and page share only committed Custom facts.
export type CustomAvailability = Readonly<{ available: number; minimum: number; sourceDigest: string }>;
export type CustomDensityIntent = Readonly<{ density: 'custom'; requestedNodes: number; serial: number }>;
export type CustomCommitFact = Readonly<{ committed: true; requestedNodes: number; available: number; clampedFrom?: number }>;
export type CustomDensityCapability = Readonly<{
  customAvailability(): CustomAvailability;
  setDensityIntent(intent: CustomDensityIntent): Promise<CustomCommitFact | 'superseded'>;
}>;
// D086-CUSTOM END
