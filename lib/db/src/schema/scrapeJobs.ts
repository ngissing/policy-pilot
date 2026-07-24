import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const scrapeJobs = pgTable(
  "scrape_jobs",
  {
    id: serial("id").primaryKey(),
    /**
     * 'generic'           — user-defined BFS crawl
     * 'pal-full'          — two-pass PAL print-all crawl
     * 'pal-maintenance'   — incremental re-crawl of recently-updated PAL topics
     * 'pal-fallback'      — link-graph crawl from enrolment hub (no slug index required)
     */
    jobType: text("job_type").notNull().default("generic"),
    seedUrl: text("seed_url").notNull(),
    status: text("status").notNull().default("pending"),
    maxDepth: integer("max_depth").notNull().default(3),
    maxPages: integer("max_pages").notNull().default(200),
    urlsFound: integer("urls_found").notNull().default(0),
    urlsProcessed: integer("urls_processed").notNull().default(0),
    docsImported: integer("docs_imported").notNull().default(0),
    docsSkipped: integer("docs_skipped").notNull().default(0),
    currentUrl: text("current_url"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("scrape_jobs_status_idx").on(t.status)]
);

export type ScrapeJob = typeof scrapeJobs.$inferSelect;
