import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ScrapeJob {
  id: number;
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

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  pending:   { label: "Pending",   color: "bg-slate-100 text-slate-600",  icon: Clock },
  running:   { label: "Running",   color: "bg-blue-100 text-blue-700",    icon: Loader2 },
  completed: { label: "Completed", color: "bg-green-100 text-green-700",  icon: CheckCircle2 },
  failed:    { label: "Failed",    color: "bg-red-100 text-red-700",      icon: XCircle },
  cancelled: { label: "Cancelled", color: "bg-amber-100 text-amber-700",  icon: AlertCircle },
};

const PRESET_URLS = [
  { label: "VIC Education PAL", url: "https://www2.education.vic.gov.au/pal" },
  { label: "NSW Education Policies", url: "https://education.nsw.gov.au/policy-library" },
  { label: "QLD Education Policies", url: "https://ppr.qed.qld.gov.au" },
  { label: "SA Education Policies", url: "https://edi.sa.edu.au/library/document-library" },
];

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

function JobCard({ job, onCancel, onDelete }: {
  job: ScrapeJob;
  onCancel: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const progress = job.maxPages > 0 ? Math.min(100, (job.urlsProcessed / job.maxPages) * 100) : 0;
  const isActive = job.status === "running" || job.status === "pending";

  return (
    <Card className={cn("transition-all", isActive && "border-blue-200 shadow-sm")}>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <StatusBadge status={job.status} />
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
                Crawling: {job.currentUrl}
              </p>
            )}
            {job.error && (
              <p className="text-xs text-red-500 mt-0.5 line-clamp-2">{job.error}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {isActive && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onCancel(job.id)}>
                <Square className="w-3 h-3 mr-1" /> Cancel
              </Button>
            )}
            {!isActive && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-slate-400 hover:text-red-500" onClick={() => onDelete(job.id)}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 px-2 text-slate-400" onClick={() => setExpanded((e) => !e)}>
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-3 grid grid-cols-4 gap-3 text-center">
          {[
            { label: "Found", value: job.urlsFound, icon: Link },
            { label: "Processed", value: job.urlsProcessed, icon: Globe },
            { label: "Imported", value: job.docsImported, icon: FileText },
            { label: "Skipped", value: job.docsSkipped, icon: AlertCircle },
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

export default function ScrapePage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [maxDepth, setMaxDepth] = useState(3);
  const [maxPages, setMaxPages] = useState(200);

  const { data: jobs = [], isLoading } = useQuery<ScrapeJob[]>({
    queryKey: ["scrape-jobs"],
    queryFn: () => apiFetch("/scrape/jobs"),
    refetchInterval: (query) => {
      const data = query.state.data as ScrapeJob[] | undefined;
      const hasActive = data?.some((j) => j.status === "running" || j.status === "pending");
      return hasActive ? 3000 : 15000;
    },
  });

  const startJob = useMutation({
    mutationFn: (payload: { seedUrl: string; maxDepth: number; maxPages: number }) =>
      apiFetch<ScrapeJob>("/scrape/jobs", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scrape-jobs"] });
      toast({ title: "Scrape job started" });
      setUrl("");
    },
    onError: (e: Error) => toast({ title: "Failed to start job", description: e.message, variant: "destructive" }),
  });

  const cancelJob = useMutation({
    mutationFn: (id: number) => apiFetch(`/scrape/jobs/${id}/cancel`, { method: "PATCH" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scrape-jobs"] }),
    onError: (e: Error) => toast({ title: "Failed to cancel", description: e.message, variant: "destructive" }),
  });

  const deleteJob = useMutation({
    mutationFn: (id: number) => apiFetch(`/scrape/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scrape-jobs"] }),
    onError: (e: Error) => toast({ title: "Failed to delete", description: e.message, variant: "destructive" }),
  });

  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "pending");
  const pastJobs = jobs.filter((j) => j.status !== "running" && j.status !== "pending");

  function handleStart() {
    const trimmed = url.trim();
    if (!trimmed) return;
    try { new URL(trimmed); } catch {
      toast({ title: "Invalid URL", description: "Please enter a valid URL including https://", variant: "destructive" });
      return;
    }
    startJob.mutate({ seedUrl: trimmed, maxDepth, maxPages });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Globe className="w-6 h-6 text-blue-600" />
          Web Scraper
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Crawl a website to automatically import policy documents into your library.
        </p>
      </div>

      {/* New job form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">New Scrape Job</CardTitle>
          <CardDescription>
            Enter a seed URL — the scraper will follow links across multiple levels on the same
            domain, extracting text from HTML pages and downloading PDFs and DOCX files.
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
              placeholder="https://www2.education.vic.gov.au/pal"
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
                onChange={(e) => setMaxDepth(Math.max(1, Math.min(10, parseInt(e.target.value) || 3)))}
              />
              <p className="text-xs text-slate-400">How many link levels deep to follow</p>
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
                onChange={(e) => setMaxPages(Math.max(1, Math.min(2000, parseInt(e.target.value) || 200)))}
              />
              <p className="text-xs text-slate-400">Safety limit on total pages visited</p>
            </div>
          </div>

          <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-500 space-y-1">
            <p className="font-medium text-slate-600">How it works</p>
            <ul className="space-y-0.5 list-disc list-inside">
              <li>Stays on the same domain as the seed URL</li>
              <li>HTML pages with enough content are imported as documents</li>
              <li>PDF and DOCX files are downloaded and processed</li>
              <li>All documents go through AI auto-tagging and appear in your library</li>
              <li>Rate-limited to be polite to the server (~600 ms between requests)</li>
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

      {/* Active jobs */}
      {activeJobs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
            Active ({activeJobs.length})
          </h2>
          {activeJobs.map((j) => (
            <JobCard key={j.id} job={j} onCancel={(id) => cancelJob.mutate(id)} onDelete={(id) => deleteJob.mutate(id)} />
          ))}
        </section>
      )}

      {/* Past jobs */}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-slate-300" />
        </div>
      ) : pastJobs.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700">History</h2>
          {pastJobs.map((j) => (
            <JobCard key={j.id} job={j} onCancel={(id) => cancelJob.mutate(id)} onDelete={(id) => deleteJob.mutate(id)} />
          ))}
        </section>
      ) : !activeJobs.length ? (
        <div className="text-center py-16 text-slate-400">
          <Globe className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No scrape jobs yet. Enter a URL above to get started.</p>
        </div>
      ) : null}
    </div>
  );
}
