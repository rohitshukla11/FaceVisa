/**
 * Marketing copy that is data, not code. Every number here is a real measurement with its source;
 * testimonials are real quotes only. An empty list hides the section entirely.
 */

export const MEASUREMENTS = {
  /** Not measured yet: null hides the card (no number without a measurement). */
  registerMs: {
    value: null as number | null,
    source: "not measured yet: the card is hidden",
  },
  /** By construction: an ad is released only after its creator approved that exact file and it was paid; the release writes its receipt. */
  rendersWithReceipt: {
    value: 100,
    source: "release() requires the creator's approval of that file hash and a settled payment, and writes the receipt in the same transaction",
  },
} as const;

export type Testimonial = { quote: string; name: string; role: string };

/** Real, attributed quotes only. Leave empty until there are some: the section is then not rendered. */
export const TESTIMONIALS: Testimonial[] = [];

export const BUILT_ON = ["World ID IDKit", "Arkiv", "Whitechain", "0G", "Next.js"];
