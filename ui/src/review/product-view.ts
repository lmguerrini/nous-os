/**
 * The product view drives the product's own renderers over the real review export.
 *
 * Placeholder until the implementation lands: it fails loudly rather than drawing anything that
 * could be mistaken for the product renderers.
 */
import type { CreateProductView } from "./view-contract.ts";

export const createProductView: CreateProductView = async () => {
  throw new Error("the product view is not implemented yet");
};
