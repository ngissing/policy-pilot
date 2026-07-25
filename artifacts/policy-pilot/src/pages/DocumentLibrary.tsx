import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import {
  useListDocuments,
  useDeleteDocument,
  getListDocumentsQueryKey,
} from "@workspace/api-client-react";
import type { ListDocumentsParams } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  FileText,
  Trash2,
  Search,
  CheckCircle,
  AlertCircle,
  Loader2,
  Clock,
  ExternalLink,
  Download,
  Globe,
  BookOpen,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiBlob } from "@/lib/api";
import { useLocation } from "wouter";

const PAGE_SIZE = 25;

const DOMAINS = [
  "all",
  "student-wellbeing",
  "curriculum",
  "staff-hr",
  "administration",
  "safety",
  "technology",
  "finance",
  "community",
  "other",
];

const DOC_TYPES = ["all", "policy", "procedure", "guideline", "framework", "strategy"];
const AUDIENCES = ["all", "staff", "students", "parents"];
const STATUSES = ["all", "approved", "pending", "rejected", "processing"];

function statusBadge(status: string) {
  if (status === "approved")
    return (
      <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
        <CheckCircle className="w-3 h-3 mr-1" />
        Approved
      </Badge>
    );
  if (status === "pending")
    return (
      <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
        <AlertCircle className="w-3 h-3 mr-1" />
        Needs Review
      </Badge>
    );
  if (status === "rejected")
    return (
      <Badge className="bg-red-100 text-red-800 hover:bg-red-100">
        <AlertCircle className="w-3 h-3 mr-1" />
        Rejected
      </Badge>
    );
  return (
    <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">
      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
      Processing
    </Badge>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function DocumentLibrary() {
  const [search, setSearch] = useState("");
  const [domain, setDomain] = useState("all");
  const [docType, setDocType] = useState("all");
  const [audience, setAudience] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const highlightId = new URLSearchParams(searchString).get("highlight");
  const highlightRef = useRef<HTMLDivElement | null>(null);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [search, domain, docType, audience, status]);

  const params: ListDocumentsParams = {
    ...(search ? { search } : {}),
    ...(domain !== "all" ? { domain } : {}),
    ...(docType !== "all" ? { documentType: docType } : {}),
    ...(audience !== "all" ? { audience } : {}),
    ...(status !== "all" ? { status } : {}),
    page,
    limit: PAGE_SIZE,
  };

  const { data: docList, isLoading } = useListDocuments(params, {
    query: { queryKey: getListDocumentsQueryKey(params), refetchInterval: 10000 },
  });

  const docs = docList?.data ?? [];
  const total = docList?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (highlightId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightId, docs]);

  const deleteMut = useDeleteDocument({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        toast({ title: "Document deleted" });
      },
      onError: (e) =>
        toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
    },
  });

  const handleDownload = async (doc: { id: number; filename: string; fileType: string }) => {
    try {
      const { blob, filename } = await apiBlob(`/documents/${doc.id}/download`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Download failed", description: "Could not download this document.", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Policy Library</h1>
        <span className="text-sm text-slate-500">
          {total > 0 ? `${total} document${total !== 1 ? "s" : ""}` : ""}
        </span>
      </div>

      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search documents…"
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={domain} onValueChange={setDomain}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Domain" />
              </SelectTrigger>
              <SelectContent>
                {DOMAINS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d === "all" ? "All Domains" : d.replace(/-/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={docType} onValueChange={setDocType}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                {DOC_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === "all" ? "All Types" : t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={audience} onValueChange={setAudience}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Audience" />
              </SelectTrigger>
              <SelectContent>
                {AUDIENCES.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a === "all" ? "All Audiences" : a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all" ? "All Status" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
        </div>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <FileText className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">No documents found</p>
          <p className="text-sm mt-1">
            {total === 0 && !search && domain === "all" && status === "all"
              ? "Upload policy documents to get started"
              : "Try adjusting your filters"}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {docs.map((doc) => {
            const isHighlighted = highlightId === String(doc.id);
            return (
              <div key={doc.id} ref={isHighlighted ? highlightRef : null}>
                <Card
                  className={`hover:shadow-md transition-all ${
                    isHighlighted ? "ring-2 ring-blue-400 shadow-md bg-blue-50" : ""
                  }`}
                >
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 min-w-0">
                        <FileText className="w-5 h-5 text-slate-400 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900 truncate">
                            {doc.title ?? doc.filename}
                          </p>
                          {doc.title && (
                            <p className="text-xs text-slate-400 truncate">{doc.filename}</p>
                          )}
                          <div className="flex flex-wrap gap-2 mt-2 items-center">
                            {statusBadge(doc.status)}
                            {doc.policyDomain && (
                              <Badge variant="outline" className="text-xs">
                                {doc.policyDomain}
                              </Badge>
                            )}
                            {doc.documentType && (
                              <Badge variant="outline" className="text-xs">
                                {doc.documentType}
                              </Badge>
                            )}
                            {doc.audience && (
                              <Badge variant="outline" className="text-xs">
                                {doc.audience}
                              </Badge>
                            )}
                            {doc.issuingAuthority && (
                              <span className="text-xs text-slate-500">
                                {doc.issuingAuthority}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 mt-1.5">
                            <Clock className="w-3 h-3 text-slate-300" />
                            <span className="text-xs text-slate-400">
                              Added {formatDate(doc.createdAt)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {doc.confidenceScore != null && (
                          <span className="text-xs text-slate-400 mr-1">
                            {Math.round(doc.confidenceScore * 100)}%
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-slate-400 hover:text-violet-600"
                          title="View wiki page"
                          onClick={() => navigate(`/wiki/${doc.id}`)}
                        >
                          <BookOpen className="w-4 h-4" />
                        </Button>
                        {doc.sourceUrl ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-slate-400 hover:text-blue-600"
                            title="Open source link"
                            asChild
                          >
                            <a href={doc.sourceUrl} target="_blank" rel="noopener noreferrer">
                              <Globe className="w-4 h-4" />
                            </a>
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-slate-400 hover:text-blue-600"
                            title="Download extracted text"
                            onClick={() => handleDownload(doc)}
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-slate-400 hover:text-red-500"
                          onClick={() => {
                            if (confirm(`Delete "${doc.title ?? doc.filename}"? This cannot be undone.`)) {
                              deleteMut.mutate({ id: doc.id });
                            }
                          }}
                          disabled={deleteMut.isPending}
                          title="Delete document"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-slate-500">
            Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="gap-1"
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </Button>
            <span className="text-sm text-slate-600 px-2">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="gap-1"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
