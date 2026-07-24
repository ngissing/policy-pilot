import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * PAL slug index — one row per topic discovered from the DET Policy and Advisory Library.
 * Maintained by the PAL crawler. Retired topics are tombstoned (isRetired = true) rather
 * than deleted so that audit history is preserved.
 */
export const palSlugs = pgTable(
  "pal_slugs",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title"),
    category: text("category"),
    /** Timestamp of the last successful print-all fetch */
    lastCrawled: timestamp("last_crawled", { withTimezone: true }),
    /** Value from the "Policy last updated" block — plain text as found on the page */
    policyLastUpdated: text("policy_last_updated"),
    /** Value from the "Reviewed {date}" footer */
    reviewedDate: text("reviewed_date"),
    /** True when the slug has disappeared from the live site */
    isRetired: boolean("is_retired").notNull().default(false),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("pal_slugs_retired_idx").on(t.isRetired),
    index("pal_slugs_category_idx").on(t.category),
  ]
);

export type PalSlug = typeof palSlugs.$inferSelect;
