/** Fixture module: shapes the totality scanner did not use to detect. */
export type SingleQuotedUnion = 'alpha' | 'beta' | 'gamma';

export type ParenthesizedUnion = ("delta" | "epsilon");

export const CONFIG_RULES = {
  ruleOne: "rule-one",
  ruleTwo: "rule-two",
} as const;

export type ConfigRule = typeof CONFIG_RULES[keyof typeof CONFIG_RULES];
