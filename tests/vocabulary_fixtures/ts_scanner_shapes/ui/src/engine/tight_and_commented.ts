/** Fixture module: ordinary spellings the totality scanner used to miss —
 * no whitespace around `=`, and a comment sitting inside the union body.
 */
export type TightSpacing="alpha"|"beta";

export type CommentedUnion = "gamma" | /* inline note */ "delta";
