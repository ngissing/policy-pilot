import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ArrowLeft,
  BookOpen,
  RefreshCw,
  Loader2,
  Clock,
  AlertCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface WikiPageData {
  id: number;
  documentId: number;
  title: string;
  slug: string;
  markdownContent: string;
  summary: string | null;
  relatedTopics: string[] | null;
  createdAt: string;
  updatedAt: string;
}

interface DocumentMeta {
  id: number;
  filename: string;
  title: string | null;
  status: string;
  policyDomain: string | null;
  documentType: string | null;
  issuingAuthority: string | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function WikiPage() {
  const { id } = useParams<{ id: string }>();
  const docId = parseInt(id ?? "", 10);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reprocessing, setReprocessing] = useState(false);

  const { data: doc } = useQuery<DocumentMeta>({
    queryKey: ["document", docId],
    queryFn: () => apiFetch(`/documents/${docId}`),
    enabled: !isNaN(docId),
  });

  const {
    data: wiki,
    isLoading,
    error,
    refetch,
  } = useQuery<WikiPageData>({
    queryKey: ["wiki", docId],
    queryFn: () => apiFetch(`/documents/${docId}/wiki`),
    enabled: !isNaN(docId),
    retry: false,
  });

  const reprocessMut = useMutation({
    mutationFn: () =>
      apiFetch(`/documents/${docId}/reprocess`, { method: "POST" }),
    onMutate: () => setReprocessing(true),
    onSuccess: () => {
      toast({ title: "Reprocessing started", description: "Wiki page will update in ~30 seconds." });
      setTimeout(() => {
        setReprocessing(false);
        refetch();
        qc.invalidateQueries({ queryKey: ["document", docId] });
      }, 30_000);
    },
    onError: (e: Error) => {
      setReprocessing(false);
      toast({ title: "Reprocess failed", description: e.message, variant: "destructive" });
    },
  });

  if (isNaN(docId)) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-400">
        <AlertCircle className="w-5 h-5 mr-2" /> Invalid document ID
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/library")}
            className="shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
              <BookOpen className="w-4 h-4 text-violet-600" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-900 truncate">
                {wiki?.title ?? doc?.title ?? doc?.filename ?? "Wiki Page"}
              </h1>
              {doc && (
                <p className="text-xs text-slate-400 truncate">{doc.filename}</p>
              )}
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-2"
          onClick={() => reprocessMut.mutate()}
          disabled={reprocessMut.isPending || reprocessing}
        >
          {reprocessing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Regenerate
        </Button>
      </div>

      {/* Meta badges */}
      {doc && (
        <div className="flex flex-wrap gap-2">
          {doc.policyDomain && (
            <Badge variant="outline" className="text-xs">{doc.policyDomain}</Badge>
          )}
          {doc.documentType && (
            <Badge variant="outline" className="text-xs">{doc.documentType}</Badge>
          )}
          {doc.issuingAuthority && (
            <Badge variant="outline" className="text-xs">{doc.issuingAuthority}</Badge>
          )}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400 mr-2" />
          <span className="text-slate-400">Loading wiki page…</span>
        </div>
      )}

      {/* Error / not found */}
      {!isLoading && error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center space-y-3">
          <AlertCircle className="w-8 h-8 text-amber-500 mx-auto" />
          <p className="font-medium text-amber-800">Wiki page not available yet</p>
          <p className="text-sm text-amber-600">
            The document may still be processing, or this feature was added after the document was
            uploaded.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 border-amber-300 text-amber-700 hover:bg-amber-100"
            onClick={() => reprocessMut.mutate()}
            disabled={reprocessMut.isPending || reprocessing}
          >
            {reprocessing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Generate wiki page now
          </Button>
        </div>
      )}

      {/* Wiki content */}
      {wiki && !isLoading && (
        <>
          {wiki.summary && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-4">
              <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide mb-1">Summary</p>
              <p className="text-sm text-slate-700 leading-relaxed">{wiki.summary}</p>
            </div>
          )}

          {wiki.relatedTopics && wiki.relatedTopics.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs text-slate-400 font-medium">Related topics:</span>
              {wiki.relatedTopics.map((t) => (
                <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
              ))}
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white">
            <ScrollArea className="h-[calc(100vh-340px)] px-8 py-6">
              <div
                className="prose prose-slate max-w-none
                  prose-headings:font-semibold prose-headings:text-slate-900
                  prose-h2:text-lg prose-h2:mt-6 prose-h2:mb-3 prose-h2:border-b prose-h2:border-slate-100 prose-h2:pb-1
                  prose-h3:text-base prose-h3:mt-4 prose-h3:mb-2
                  prose-p:text-slate-700 prose-p:leading-relaxed prose-p:my-2
                  prose-ul:my-2 prose-ul:pl-5 prose-li:my-1 prose-li:text-slate-700
                  prose-ol:my-2 prose-ol:pl-5
                  prose-strong:font-semibold prose-strong:text-slate-900
                  prose-blockquote:border-l-4 prose-blockquote:border-violet-200 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-slate-500
                  prose-code:bg-slate-100 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:text-slate-800"
              >
                <ReactMarkdown>{wiki.markdownContent}</ReactMarkdown>
              </div>
            </ScrollArea>
          </div>

          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Clock className="w-3 h-3" />
            <span>Last generated {formatDate(wiki.updatedAt)}</span>
          </div>
        </>
      )}
    </div>
  );
}
