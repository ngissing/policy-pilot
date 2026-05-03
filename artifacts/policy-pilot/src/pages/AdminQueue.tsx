import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Document {
  id: number;
  filename: string;
  title?: string | null;
  fileType: string;
  issuingAuthority?: string | null;
  policyDomain?: string | null;
  documentType?: string | null;
  audience?: string | null;
  confidenceScore?: number | null;
  status: string;
}

const DOMAINS = [
  "student-wellbeing", "curriculum", "staff-hr", "administration",
  "safety", "technology", "finance", "community", "other",
];
const DOC_TYPES = ["policy", "procedure", "guideline", "framework", "strategy"];
const AUDIENCES = ["staff", "students", "parents", "all"];

export default function AdminQueue() {
  const [editing, setEditing] = useState<Document | null>(null);
  const [form, setForm] = useState<Partial<Document>>({});
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: queue = [], isLoading } = useQuery<Document[]>({
    queryKey: ["review-queue"],
    queryFn: () => apiFetch("/documents/review-queue"),
    refetchInterval: 10000,
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Document> }) =>
      apiFetch(`/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["review-queue"] });
      qc.invalidateQueries({ queryKey: ["documents"] });
      setEditing(null);
      const action = vars.data.status === "rejected" ? "rejected" : "approved";
      toast({ title: `Document ${action}` });
    },
    onError: (e: Error) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const openEdit = (doc: Document) => {
    setEditing(doc);
    setForm({
      title: doc.title ?? "",
      issuingAuthority: doc.issuingAuthority ?? "",
      policyDomain: doc.policyDomain ?? "",
      documentType: doc.documentType ?? "",
      audience: doc.audience ?? "",
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Review Document</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <p className="text-sm text-slate-500 truncate">{editing.filename}</p>
              {editing.confidenceScore != null && (
                <Badge className="bg-amber-50 text-amber-700 hover:bg-amber-50">
                  AI confidence: {Math.round(editing.confidenceScore * 100)}%
                </Badge>
              )}

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
          )}
          <DialogFooter className="gap-2">
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
