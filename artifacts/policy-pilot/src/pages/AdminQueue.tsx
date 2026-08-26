import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetReviewQueue,
  useUpdateDocument,
  getGetReviewQueueQueryKey,
  getListDocumentsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import {
  FileText,
  Edit,
  CheckCircle,
  AlertCircle,
  Loader2,
  XCircle,
  BookOpen,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import type { Document, UpdateDocumentBody } from "@workspace/api-client-react";

const DOMAINS = [
  "student-wellbeing", "curriculum", "staff-hr", "administration",
  "safety", "technology", "finance", "community", "other",
];
const DOC_TYPES = ["policy", "procedure", "guideline", "framework", "strategy"];
const AUDIENCES = ["staff", "students", "parents", "all"];
const RESOURCE_SCOPES = [
  { value: "school", label: "School-specific" },
  { value: "department", label: "Department / government" },
  { value: "external", label: "Other external resource" },
  { value: "unknown", label: "Unknown" },
];

type FormState = Pick<
  UpdateDocumentBody,
  "title" | "issuingAuthority" | "policyDomain" | "documentType" | "audience" | "resourceScope"
>;

interface WikiPreview {
  summary: string | null;
  markdownContent: string;
}

export default function AdminQueue() {
  const [editing, setEditing] = useState<Document | null>(null);
  const [form, setForm] = useState<FormState>({});
  const [wikiPreview, setWikiPreview] = useState<WikiPreview | null>(null);
  const [wikiLoading, setWikiLoading] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: queue = [], isLoading } = useGetReviewQueue({
    query: { queryKey: getGetReviewQueueQueryKey(), refetchInterval: 10000 },
  });

  const updateMut = useUpdateDocument({
    mutation: {
      onSuccess: (_data, vars) => {
        qc.invalidateQueries({ queryKey: getGetReviewQueueQueryKey() });
        qc.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        setEditing(null);
        const action = vars.data.status === "rejected" ? "rejected" : "approved";
        toast({ title: `Document ${action}` });
      },
      onError: (e) =>
        toast({ title: "Error", description: e.message, variant: "destructive" }),
    },
  });

  // Fetch wiki preview whenever a document is opened for review
  useEffect(() => {
    if (!editing) {
      setWikiPreview(null);
      return;
    }
    setWikiLoading(true);
    apiFetch<WikiPreview>(`/documents/${editing.id}/wiki`)
      .then((w) => setWikiPreview(w))
      .catch(() => setWikiPreview(null))
      .finally(() => setWikiLoading(false));
  }, [editing?.id]);

  const openEdit = (doc: Document) => {
    setEditing(doc);
    setForm({
      title: doc.title ?? "",
      issuingAuthority: doc.issuingAuthority ?? "",
      policyDomain: doc.policyDomain ?? "",
      documentType: doc.documentType ?? "",
      audience: doc.audience ?? "",
      resourceScope: doc.resourceScope ?? "unknown",
    });
  };

  const approve = () => {
    if (!editing) return;
    updateMut.mutate({ id: editing.id, data: { ...form, status: "approved" } });
  };

  const reject = () => {
    if (!editing) return;
    updateMut.mutate({ id: editing.id, data: { status: "rejected" } });
  };

  // Extract first 2 meaningful sections from wiki markdown for the preview
  function extractWikiPreviewText(markdown: string): string {
    const sections = markdown.split(/\n(?=## )/).slice(0, 2);
    return sections
      .map((s) => s.trim())
      .join("\n\n")
      .slice(0, 600);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Review Queue</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Documents where AI confidence is below 75% — review, approve, or reject
          </p>
        </div>
        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 text-sm px-3 py-1">
          <AlertCircle className="w-3.5 h-3.5 mr-1.5" />
          {queue.length} pending
        </Badge>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
        </div>
      ) : queue.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <CheckCircle className="w-12 h-12 mx-auto mb-3 opacity-40 text-green-400" />
          <p className="text-lg font-medium text-slate-600">All caught up!</p>
          <p className="text-sm mt-1">No documents need review right now</p>
        </div>
      ) : (
        <div className="space-y-3">
          {queue.map((doc) => (
            <Card key={doc.id} className="border-amber-100">
              <CardContent className="py-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="w-5 h-5 text-amber-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 truncate">
                        {doc.title ?? doc.filename}
                      </p>
                      {doc.title && (
                        <p className="text-xs text-slate-400 truncate">{doc.filename}</p>
                      )}
                      <div className="flex flex-wrap gap-2 mt-1.5">
                        {doc.confidenceScore != null && (
                          <Badge className="bg-amber-50 text-amber-700 hover:bg-amber-50 text-xs">
                            {Math.round(doc.confidenceScore * 100)}% confidence
                          </Badge>
                        )}
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
                        {doc.issuingAuthority && (
                          <Badge variant="outline" className="text-xs text-slate-500">
                            {doc.issuingAuthority}
                          </Badge>
                        )}
                        <Badge className="bg-blue-50 text-blue-700 hover:bg-blue-50 text-xs">
                          {doc.resourceScope === "school"
                            ? "School-specific"
                            : doc.resourceScope === "department"
                            ? "Department"
                            : doc.resourceScope === "external"
                            ? "External"
                            : "Unknown source"}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(doc)}
                    >
                      <Edit className="w-3.5 h-3.5 mr-1.5" />
                      Review
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Review Document</DialogTitle>
              <DialogDescription>
                Confirm the suggested metadata and choose the resource scope used by Chat filters.
              </DialogDescription>
          </DialogHeader>

          {editing && (
            <ScrollArea className="flex-1 overflow-y-auto pr-1">
              <div className="space-y-4 pb-2">
                <p className="text-sm text-slate-500 truncate">{editing.filename}</p>
                {editing.confidenceScore != null && (
                  <Badge className="bg-amber-50 text-amber-700 hover:bg-amber-50">
                    AI confidence: {Math.round(editing.confidenceScore * 100)}%
                  </Badge>
                )}

                {/* Wiki content preview */}
                <div className="rounded-lg border border-slate-200 bg-slate-50 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-white">
                    <BookOpen className="w-3.5 h-3.5 text-violet-500" />
                    <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                      AI-generated wiki preview
                    </span>
                  </div>
                  <div className="px-3 py-3">
                    {wikiLoading ? (
                      <div className="flex items-center gap-2 text-slate-400 py-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span className="text-xs">Loading wiki…</span>
                      </div>
                    ) : wikiPreview ? (
                      <div className="space-y-2">
                        {wikiPreview.summary && (
                          <p className="text-sm text-slate-700 leading-relaxed border-l-2 border-violet-300 pl-3 italic">
                            {wikiPreview.summary}
                          </p>
                        )}
                        <pre className="text-xs text-slate-600 whitespace-pre-wrap leading-relaxed font-sans">
                          {extractWikiPreviewText(wikiPreview.markdownContent)}
                          {wikiPreview.markdownContent.length > 600 && (
                            <span className="text-slate-400"> …(truncated)</span>
                          )}
                        </pre>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 py-1">
                        No wiki page generated yet — document may still be processing.
                      </p>
                    )}
                  </div>
                </div>

                {/* Editable metadata fields */}
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input
                    value={form.title ?? ""}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="Document title"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Issuing Authority</Label>
                  <Input
                    value={form.issuingAuthority ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, issuingAuthority: e.target.value })
                    }
                    placeholder="e.g. Department of Education, School Name"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Resource Scope</Label>
                  <Select
                    value={form.resourceScope ?? "unknown"}
                    onValueChange={(v) =>
                      setForm({
                        ...form,
                        resourceScope: v as UpdateDocumentBody["resourceScope"],
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select scope…" />
                    </SelectTrigger>
                    <SelectContent>
                      {RESOURCE_SCOPES.map((scope) => (
                        <SelectItem key={scope.value} value={scope.value}>
                          {scope.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">
                    This controls whether the document appears in School or Department Chat searches.
                  </p>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-2">
                    <Label>Domain</Label>
                    <Select
                      value={form.policyDomain ?? ""}
                      onValueChange={(v) => setForm({ ...form, policyDomain: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select…" />
                      </SelectTrigger>
                      <SelectContent>
                        {DOMAINS.map((d) => (
                          <SelectItem key={d} value={d}>
                            {d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Type</Label>
                    <Select
                      value={form.documentType ?? ""}
                      onValueChange={(v) => setForm({ ...form, documentType: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select…" />
                      </SelectTrigger>
                      <SelectContent>
                        {DOC_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Audience</Label>
                    <Select
                      value={form.audience ?? ""}
                      onValueChange={(v) => setForm({ ...form, audience: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select…" />
                      </SelectTrigger>
                      <SelectContent>
                        {AUDIENCES.map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </ScrollArea>
          )}

          <DialogFooter className="gap-2 pt-2 border-t border-slate-100">
            <Button
              variant="outline"
              onClick={reject}
              disabled={updateMut.isPending}
              className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              <XCircle className="w-3.5 h-3.5 mr-1.5" />
              Reject
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={approve}
              disabled={updateMut.isPending}
              className="bg-green-600 hover:bg-green-700"
            >
              {updateMut.isPending ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
              )}
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
