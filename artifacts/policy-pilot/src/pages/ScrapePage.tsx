import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Globe,
  Play,
  Square,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  FileText,
  Link,
  ChevronDown,
  ChevronUp,
  BookOpen,
  Wrench,
  RefreshCw,
  Database,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScrapeJob {
  id: number;
  jobType: string;
  seedUrl: string;
  status: string;
  maxDepth: number;
  maxPages: number;
  urlsFound: number;
  urlsProcessed: number;
  docsImported: number;
  docsSkipped: number;
  currentUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface PalStats {
  total: number;
  active: number;
  retired: number;
  lastCrawled: string | null;
  byCategory: Record<string, number>;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  pending:   { label: "Pending",   color: "bg-slate-100 text-slate-600",  icon: Clock },
  running:   { label: "Running",   color: "bg-blue-100 text-blue-700",    icon: Loader2 },
  completed: { label: "Completed", color: "bg-green-100 text-green-700",  icon: CheckCircle2 },
  failed:    { label: "Failed",    color: "bg-red-100 text-red-700",      icon: XCircle },
  cancelled: { label: "Cancelled", color: "bg-amber-100 text-amber-700",  icon: AlertCircle },
};

const JOB_TYPE_LABELS: Record<string, string> = {
  generic:          "Custom Scrape",
  "pal-full":       "PAL Full Crawl",
  "pal-maintenance":"PAL Maintenance",
  "pal-fallback":   "PAL Fallback Crawl",
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full", cfg.color)}>
      <Icon className={cn("w-3 h-3", status === "running" && "animate-spin")} />
      {cfg.label}
    </span>
  );
}

function JobCard({
  job,
  onCancel,
  onDelete,
}: {
  job: ScrapeJob;
  onCancel: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const progress =
    job.maxPages > 0 ? Math.min(100, (job.urlsProcessed / job.maxPages) * 100) : 0;
  const isActive = job.status === "running" || job.status === "pending";

  return (
    <Card className={cn("transition-all", isActive && "border-blue-200 shadow-sm")}>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <StatusBadge status={job.status} />
              <span className="text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                {JOB_TYPE_LABELS[job.jobType] ?? job.jobType}
              </span>
              <span className="text-xs text-slate-400">#{job.id}</span>
              <span className="text-xs text-slate-400">
                {new Date(job.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-sm font-medium text-slate-800 truncate" title={job.seedUrl}>
              {job.seedUrl}
            </p>
            {job.status === "running" && job.currentUrl && (
              <p className="text-xs text-slate-400 mt-0.5 truncate" title={job.currentUrl}>
                {job.currentUrl}
              </p>
            )}
            {job.error && (
              <p className="text-xs text-red-500 mt-0.5 line-clamp-2">{job.error}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {isActive && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => onCancel(job.id)}
              >
                <Square className="w-3 h-3 mr-1" /> Cancel
              </Button>
            )}
            {!isActive && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-slate-400 hover:text-red-500"
                onClick={() => onDelete(job.id)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-slate-400"
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-3 grid grid-cols-4 gap-3 text-center">
          {[
            { label: "Found",     value: job.urlsFound,     icon: Link },
            { label: "Processed", value: job.urlsProcessed, icon: Globe },
            { label: "Imported",  value: job.docsImported,  icon: FileText },
            { label: "Skipped",   value: job.docsSkipped,   icon: AlertCircle },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="bg-slate-50 rounded-lg py-2">
              <Icon className="w-3.5 h-3.5 text-slate-400 mx-auto mb-0.5" />
              <p className="text-base font-semibold text-slate-800">{value}</p>
              <p className="text-xs text-slate-400">{label}</p>
            </div>
          ))}
        </div>

        {isActive && (
          <div className="mt-3 space-y-1">
            <div className="flex justify-between text-xs text-slate-400">
              <span>{job.urlsProcessed} of {job.maxPages} pages</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-1.5" />
          </div>
        )}

        {expanded && (
          <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-500">
            <div><span className="font-medium">Max depth:</span> {job.maxDepth}</div>
            <div><span className="font-medium">Max pages:</span> {job.maxPages}</div>
            {job.completedAt && (
              <div className="col-span-2">
                <span className="font-medium">Completed:</span>{" "}
                {new Date(job.completedAt).toLocaleString()}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Shared job list ──────────────────────────────────────────────────────────

function JobList({
  jobs,
  isLoading,
  onCancel,
  onDelete,
  emptyMessage,
  filterFn,
}: {
  jobs: ScrapeJob[];
  isLoading: boolean;
  onCancel: (id: number) => void;
  onDelete: (id: number) => void;
  emptyMessage: string;
  filterFn: (j: ScrapeJob) => boolean;
}) {
  const filtered = jobs.filter(filterFn);
  const active = filtered.filter((j) => j.status === "running" || j.status === "pending");
  const past = filtered.filter((j) => j.status !== "running" && j.status !== "pending");

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-slate-300" />
      </div>
    );
  }

  if (!filtered.length) {
    return (
      <div className="text-center py-10 text-slate-400">
        <Globe className="w-8 h-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {active.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
            Active ({active.length})
          </h3>
          {active.map((j) => (
            <JobCard key={j.id} job={j} onCancel={onCancel} onDelete={onDelete} />
          ))}
        </section>
      )}
      {past.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">History</h3>
          {past.map((j) => (
            <JobCard key={j.id} job={j} onCancel={onCancel} onDelete={onDelete} />
          ))}
        </section>
      )}
    </div>
  );
}

// ─── PAL tab ──────────────────────────────────────────────────────────────────

type PalMode = "full" | "maintenance" | "fallback";

const PAL_MODES: Array<{
  id: PalMode;
  label: string;
  icon: React.ElementType;
  description: string;
  badge?: string;
}> = [
  {
    id: "full",
    label: "Full Ingestion",
    icon: Database,
    description:
      "Two-pass crawl: discovers all PAL topics via recently-updated & related-policies links, then fetches every topic's print-all page.",
    badge: "Recommended",
  },
  {
    id: "maintenance",
    label: "Maintenance Check",
    icon: RefreshCw,
    description:
      "Re-crawls only topics that have appeared on /pal/recently-updated since the last run. Fast weekly update.",
  },
  {
    id: "fallback",
    label: "Fallback Link Crawl",
    icon: Wrench,
    description:
      "BFS from the enrolment hub, following related-policies links across 5 levels. Use if the slug index is unavailable. Slower, coverage not guaranteed.",
  },
];

function PalTab({
  jobs,
  isLoading,
  onCancel,
  onDelete,
}: {
  jobs: ScrapeJob[];
  isLoading: boolean;
  onCancel: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedMode, setSelectedMode] = useState<PalMode>("full");
  const [sinceDate, setSinceDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split("T")[0];
  });

  const { data: stats, isLoading: statsLoading } = useQuery<PalStats>({
    queryKey: ["pal-stats"],
    queryFn: () => apiFetch("/scrape/pal/stats"),
    refetchInterval: 30_000,
  });

  const startPalJob = useMutation({
    mutationFn: (payload: { mode: PalMode; sinceDate?: string }) =>
      apiFetch<ScrapeJob>("/scrape/pal/start", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: ["scrape-jobs"] });
      qc.invalidateQueries({ queryKey: ["pal-stats"] });
      toast({ title: `PAL ${job.jobType.replace("pal-", "")} job started` });
    },
    onError: (e: Error) =>
      toast({ title: "Failed to start PAL job", description: e.message, variant: "destructive" }),
  });

  function handleStart() {
    startPalJob.mutate({
      mode: selectedMode,
      sinceDate: selectedMode === "maintenance" ? sinceDate : undefined,
    });
  }

  const isPalJob = (j: ScrapeJob) => (j.jobType ?? "generic").startsWith("pal-");

  return (
    <div className="space-y-5">
      {/* Slug index status card */}
      <Card className="bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-blue-900 flex items-center gap-1.5">
                <BookOpen className="w-4 h-4" />
                PAL Slug Index
              </p>
              {statsLoading ? (
                <p className="text-xs text-blue-700 mt-1 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading stats…
                </p>
              ) : stats && stats.total > 0 ? (
                <div className="mt-1 space-y-0.5">
                  <p className="text-xs text-blue-800">
                    <span className="font-semibold">{stats.active}</span> active topics
                    {stats.retired > 0 && (
                      <span className="text-blue-600 ml-1">· {stats.retired} retired</span>
                    )}
                  </p>
                  {stats.lastCrawled && (
                    <p className="text-xs text-blue-700">
                      Last crawled: {new Date(stats.lastCrawled).toLocaleDateString("en-AU", {
                        day: "numeric", month: "short", year: "numeric",
                      })}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-blue-700 mt-1">
                  No topics indexed yet — run a Full Ingestion to get started.
                </p>
              )}
            </div>
            {stats && Object.keys(stats.byCategory).length > 0 && (
              <div className="hidden sm:block text-right">
                <p className="text-xs text-blue-700 font-medium mb-1">By category</p>
                {Object.entries(stats.byCategory)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 4)
                  .map(([cat, count]) => (
                    <p key={cat} className="text-xs text-blue-600">
                      {count} · {cat.length > 30 ? cat.slice(0, 28) + "…" : cat}
                    </p>
                  ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Mode selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Launch PAL Ingestion</CardTitle>
          <CardDescription>
            Ingest the Victorian DET Policy and Advisory Library at{" "}
            <a
              href="https://www2.education.vic.gov.au/pal"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              www2.education.vic.gov.au/pal
            </a>
            . Choose a mode, then start the job.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Mode cards */}
          <div className="space-y-2">
            {PAL_MODES.map(({ id, label, icon: Icon, description, badge }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSelectedMode(id)}
                className={cn(
                  "w-full text-left rounded-lg border p-3 transition-all",
                  selectedMode === id
                    ? "border-blue-400 bg-blue-50 shadow-sm"
                    : "border-slate-200 hover:border-blue-200 hover:bg-slate-50"
                )}
              >
                <div className="flex items-start gap-3">
                  <div className={cn(
                    "w-7 h-7 rounded-md flex items-center justify-center shrink-0 mt-0.5",
                    selectedMode === id ? "bg-blue-100" : "bg-slate-100"
                  )}>
                    <Icon className={cn("w-4 h-4", selectedMode === id ? "text-blue-600" : "text-slate-500")} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "text-sm font-medium",
                        selectedMode === id ? "text-blue-900" : "text-slate-700"
                      )}>
                        {label}
                      </span>
                      {badge && (
                        <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">
                          {badge}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{description}</p>
                  </div>
                  <div className={cn(
                    "w-4 h-4 rounded-full border-2 shrink-0 mt-1 transition-colors",
                    selectedMode === id
                      ? "border-blue-500 bg-blue-500"
                      : "border-slate-300"
                  )} />
                </div>
              </button>
            ))}
          </div>

          {/* Maintenance: since-date picker */}
          {selectedMode === "maintenance" && (
            <div className="space-y-1.5">
              <Label htmlFor="since-date" className="text-sm">
                Re-crawl topics updated since
              </Label>
              <Input
                id="since-date"
                type="date"
                value={sinceDate}
                onChange={(e) => setSinceDate(e.target.value)}
                className="max-w-xs"
              />
              <p className="text-xs text-slate-400">
                Topics that appeared on /pal/recently-updated after this date will be re-fetched.
              </p>
            </div>
          )}

          {/* Spec notice */}
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-700 space-y-1.5">
            <p className="font-medium text-slate-800">📋 How discovery works</p>
            <ul className="space-y-1 list-disc list-inside text-slate-600">
              <li><span className="font-medium">Sitemap</span> — fetches sitemap.xml (flat, ~656 KB) and extracts all 456 topic roots with their <code className="bg-slate-100 px-0.5 rounded">lastmod</code> dates. If the count falls outside 3,000–4,000 PAL URLs the job aborts and alerts.</li>
              <li><span className="font-medium">Categories</span> — optionally enriched from DET&apos;s Elasticsearch endpoint (DET&apos;s own category labels, up to 2 per topic). Degrades gracefully if the endpoint is CORS-blocked from the server.</li>
              <li><span className="font-medium">Maintenance</span> — compares sitemap <code className="bg-slate-100 px-0.5 rounded">lastmod</code> against stored values; re-crawls only changed topics and tombstones any slug no longer in the sitemap.</li>
              <li><span className="font-medium">Politeness</span> — 600 ms delay, verified against robots.txt 24 Jul 2026.</li>
            </ul>
            <p className="text-slate-500 pt-0.5">Two known sitemap/ES reconciliation anomalies: <em>right-to-disconnect</em> and <em>teach-the-future-fellowship-program</em> lack a /pal/ segment in the ES data — their categories may be missing until manually resolved.</p>
          </div>

          <Button
            onClick={handleStart}
            disabled={startPalJob.isPending}
            className="w-full bg-blue-600 hover:bg-blue-700"
          >
            {startPalJob.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Play className="w-4 h-4 mr-2" />
            )}
            Start{" "}
            {selectedMode === "full"
              ? "Full Ingestion"
              : selectedMode === "maintenance"
              ? "Maintenance Check"
              : "Fallback Crawl"}
          </Button>
        </CardContent>
      </Card>

      {/* PAL job history */}
      <JobList
        jobs={jobs}
        isLoading={isLoading}
        onCancel={onCancel}
        onDelete={onDelete}
        filterFn={isPalJob}
        emptyMessage="No PAL jobs yet. Start a Full Ingestion above."
      />
    </div>
  );
}

// ─── Custom scrape tab ─────────────────────────────────────────────────────────

const PRESET_URLS = [
  { label: "NSW Education Policies", url: "https://education.nsw.gov.au/policy-library" },
  { label: "QLD Education Policies", url: "https://ppr.qed.qld.gov.au" },
  { label: "SA Education Policies", url: "https://edi.sa.edu.au/library/document-library" },
];

function CustomScrapeTab({
  jobs,
  isLoading,
  onCancel,
  onDelete,
}: {
  jobs: ScrapeJob[];
  isLoading: boolean;
  onCancel: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [maxDepth, setMaxDepth] = useState(3);
  const [maxPages, setMaxPages] = useState(200);

  const startJob = useMutation({
    mutationFn: (payload: { seedUrl: string; maxDepth: number; maxPages: number }) =>
      apiFetch<ScrapeJob>("/scrape/jobs", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scrape-jobs"] });
      toast({ title: "Scrape job started" });
      setUrl("");
    },
    onError: (e: Error) =>
      toast({ title: "Failed to start job", description: e.message, variant: "destructive" }),
  });

  function handleStart() {
    const trimmed = url.trim();
    if (!trimmed) return;
    try { new URL(trimmed); } catch {
      toast({
        title: "Invalid URL",
        description: "Please enter a valid URL including https://",
        variant: "destructive",
      });
      return;
    }
    startJob.mutate({ seedUrl: trimmed, maxDepth, maxPages });
  }

  const isGenericJob = (j: ScrapeJob) => (j.jobType ?? "generic") === "generic";

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">New Scrape Job</CardTitle>
          <CardDescription>
            Crawl any website to import policy documents. Stays on the same domain as the seed
            URL, extracts HTML pages and downloads PDFs and DOCX files.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Preset shortcuts */}
          <div>
            <p className="text-xs font-medium text-slate-500 mb-2">Quick presets</p>
            <div className="flex flex-wrap gap-2">
              {PRESET_URLS.map(({ label, url: presetUrl }) => (
                <button
                  key={presetUrl}
                  type="button"
                  onClick={() => setUrl(presetUrl)}
                  className="text-xs px-3 py-1 rounded-full border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700 transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="seed-url" className="text-sm">Seed URL</Label>
            <Input
              id="seed-url"
              placeholder="https://example.edu.au/policy-library"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleStart()}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="max-depth" className="text-sm">
                Max depth <span className="text-slate-400 font-normal">(link levels)</span>
              </Label>
              <Input
                id="max-depth"
                type="number"
                min={1}
                max={10}
                value={maxDepth}
                onChange={(e) =>
                  setMaxDepth(Math.max(1, Math.min(10, parseInt(e.target.value) || 3)))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="max-pages" className="text-sm">
                Max pages <span className="text-slate-400 font-normal">(total)</span>
              </Label>
              <Input
                id="max-pages"
                type="number"
                min={1}
                max={2000}
                value={maxPages}
                onChange={(e) =>
                  setMaxPages(Math.max(1, Math.min(2000, parseInt(e.target.value) || 200)))
                }
              />
            </div>
          </div>

          <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-500 space-y-1">
            <p className="font-medium text-slate-600">How it works</p>
            <ul className="space-y-0.5 list-disc list-inside">
              <li>Stays on the same domain as the seed URL</li>
              <li>HTML pages with enough content are imported as documents</li>
              <li>PDF and DOCX files are downloaded and processed</li>
              <li>All documents go through AI auto-tagging and appear in your library</li>
              <li>Rate-limited to ~600 ms between requests</li>
            </ul>
          </div>

          <Button
            onClick={handleStart}
            disabled={!url.trim() || startJob.isPending}
            className="w-full bg-blue-600 hover:bg-blue-700"
          >
            {startJob.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Play className="w-4 h-4 mr-2" />
            )}
            Start Scraping
          </Button>
        </CardContent>
      </Card>

      <JobList
        jobs={jobs}
        isLoading={isLoading}
        onCancel={onCancel}
        onDelete={onDelete}
        filterFn={isGenericJob}
        emptyMessage="No custom scrape jobs yet. Enter a URL above to get started."
      />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ScrapePage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: jobs = [], isLoading } = useQuery<ScrapeJob[]>({
    queryKey: ["scrape-jobs"],
    queryFn: () => apiFetch("/scrape/jobs"),
    refetchInterval: (query) => {
      const data = query.state.data as ScrapeJob[] | undefined;
      const hasActive = data?.some(
        (j) => j.status === "running" || j.status === "pending"
      );
      return hasActive ? 3000 : 15000;
    },
  });

  const cancelJob = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/scrape/jobs/${id}/cancel`, { method: "PATCH" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scrape-jobs"] });
      qc.invalidateQueries({ queryKey: ["pal-stats"] });
    },
    onError: (e: Error) =>
      toast({ title: "Failed to cancel", description: e.message, variant: "destructive" }),
  });

  const deleteJob = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/scrape/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scrape-jobs"] }),
    onError: (e: Error) =>
      toast({ title: "Failed to delete", description: e.message, variant: "destructive" }),
  });

  const sharedProps = {
    jobs,
    isLoading,
    onCancel: (id: number) => cancelJob.mutate(id),
    onDelete: (id: number) => deleteJob.mutate(id),
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Globe className="w-6 h-6 text-blue-600" />
          Web Scraper
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Crawl policy sites to automatically import documents into your library.
        </p>
      </div>

      <Tabs defaultValue="pal">
        <TabsList className="w-full">
          <TabsTrigger value="pal" className="flex-1 flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5" />
            DET PAL
          </TabsTrigger>
          <TabsTrigger value="custom" className="flex-1 flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5" />
            Custom Scrape
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pal" className="mt-5">
          <PalTab {...sharedProps} />
        </TabsContent>

        <TabsContent value="custom" className="mt-5">
          <CustomScrapeTab {...sharedProps} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
