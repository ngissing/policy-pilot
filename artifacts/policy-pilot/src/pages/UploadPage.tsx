import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiUpload } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Upload,
  FileText,
  X,
  CheckCircle,
  AlertCircle,
  CloudUpload,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useDropzone } from "react-dropzone";

interface UploadResult {
  id: number;
  filename: string;
  status: string;
  message: string;
}

interface BatchUploadResponse {
  results: UploadResult[];
  errors: Array<{ filename: string; error: string }>;
}

interface DocumentMeta {
  id: number;
  status: string;
  policyDomain?: string | null;
  documentType?: string | null;
  issuingAuthority?: string | null;
  audience?: string | null;
  confidenceScore?: number | null;
  title?: string | null;
}

interface FileState {
  file: File;
  status: "pending" | "uploading" | "processing" | "tagged" | "review" | "error";
  documentId?: number;
  meta?: DocumentMeta;
  error?: string;
}

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 20;

export default function UploadPage() {
  const [files, setFiles] = useState<FileState[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const pollCountsRef = useRef<Map<number, number>>(new Map());
  const { toast } = useToast();
  const qc = useQueryClient();

  const onDrop = useCallback((accepted: File[]) => {
    const newFiles = accepted.map((f) => ({ file: f, status: "pending" as const }));
    setFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "text/plain": [".txt"],
    },
    multiple: true,
  });

  useEffect(() => {
    const processingIds = files
      .filter((f) => f.status === "processing" && f.documentId != null)
      .map((f) => f.documentId as number);

    if (processingIds.length === 0) return;

    const timer = setInterval(async () => {
      for (const docId of processingIds) {
        const attempts = pollCountsRef.current.get(docId) ?? 0;
        if (attempts >= POLL_MAX_ATTEMPTS) {
          setFiles((prev) =>
            prev.map((f) =>
              f.documentId === docId && f.status === "processing"
                ? { ...f, status: "review", meta: f.meta }
                : f
            )
          );
          continue;
        }
        pollCountsRef.current.set(docId, attempts + 1);

        try {
          const doc = await apiFetch<DocumentMeta>(`/documents/${docId}`);
          if (doc.status !== "processing") {
            setFiles((prev) =>
              prev.map((f) =>
                f.documentId === docId
                  ? {
                      ...f,
                      status: doc.status === "approved" ? "tagged" : "review",
                      meta: doc,
                    }
                  : f
              )
            );
            qc.invalidateQueries({ queryKey: ["documents"] });
            qc.invalidateQueries({ queryKey: ["stats"] });
          }
        } catch {
          // non-fatal polling failure — will retry
        }
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [files, qc]);

  const uploadAll = async () => {
    const pending = files.filter((f) => f.status === "pending");
    if (pending.length === 0 || isUploading) return;

    setIsUploading(true);
    setFiles((prev) =>
      prev.map((f) => (f.status === "pending" ? { ...f, status: "uploading" } : f))
    );

    try {
      const formData = new FormData();
      for (const fs of pending) {
        formData.append("files", fs.file);
      }

      const batch = await apiUpload<BatchUploadResponse>("/documents/upload", formData);
      const results: UploadResult[] = batch.results ?? [];
      const errors: Array<{ filename: string; error: string }> = batch.errors ?? [];

      const resultByFilename = new Map(results.map((r) => [r.filename, r]));
      const errorByFilename = new Map(errors.map((e) => [e.filename, e.error]));

      setFiles((prev) =>
        prev.map((f) => {
          if (f.status !== "uploading") return f;
          const result = resultByFilename.get(f.file.name);
          const errMsg = errorByFilename.get(f.file.name);
          if (result) {
            return { ...f, status: "processing", documentId: result.id };
          } else if (errMsg) {
            return { ...f, status: "error", error: errMsg };
          }
          return { ...f, status: "error", error: "No response received" };
        })
      );

      toast({
        title: `${results.length} file${results.length > 1 ? "s" : ""} uploaded`,
        description: "AI tagging and indexing in progress…",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setFiles((prev) =>
        prev.map((f) =>
          f.status === "uploading" ? { ...f, status: "error", error: message } : f
        )
      );
      toast({ title: "Upload failed", description: message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const removeFile = (f: FileState) => {
    setFiles((prev) => prev.filter((x) => x !== f));
  };

  const pendingCount = files.filter((f) => f.status === "pending").length;

  function statusBadge(fs: FileState) {
    switch (fs.status) {
      case "uploading":
        return <Loader2 className="w-4 h-4 animate-spin text-blue-400 shrink-0" />;
      case "processing":
        return (
          <span className="flex items-center gap-1 text-xs text-blue-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            AI tagging…
          </span>
        );
      case "tagged":
        return <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />;
      case "review":
        return (
          <span className="flex items-center gap-1 text-xs text-amber-500">
            <AlertCircle className="w-3.5 h-3.5" />
            Needs review
          </span>
        );
      case "error":
        return (
          <div className="flex items-center gap-1">
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
            <span className="text-xs text-red-500 max-w-24 truncate">{fs.error}</span>
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Upload Documents</h1>
        <p className="text-slate-500 mt-1">
          Upload PDF, DOCX, or TXT policy documents. AI will automatically tag them with
          metadata and index them for search.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
              isDragActive
                ? "border-blue-500 bg-blue-50"
                : "border-slate-200 hover:border-blue-400 hover:bg-slate-50"
            }`}
          >
            <input {...getInputProps()} />
            <CloudUpload className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            {isDragActive ? (
              <p className="text-blue-600 font-medium">Drop files here…</p>
            ) : (
              <>
                <p className="text-slate-700 font-medium">
                  Drag & drop files here, or{" "}
                  <span className="text-blue-600">browse</span>
                </p>
                <p className="text-sm text-slate-400 mt-1">
                  PDF, DOCX, TXT — up to 20MB each, max 20 files per upload
                </p>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {files.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Files ({files.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {files.map((fs, i) => (
              <div key={i} className="rounded-lg border border-slate-100 bg-slate-50 overflow-hidden">
                <div className="flex items-center gap-3 p-3">
                  <FileText className="w-5 h-5 text-slate-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">
                      {fs.meta?.title ?? fs.file.name}
                    </p>
                    {fs.meta?.title && (
                      <p className="text-xs text-slate-400 truncate">{fs.file.name}</p>
                    )}
                    <p className="text-xs text-slate-400">
                      {(fs.file.size / 1024).toFixed(0)} KB
                    </p>
                  </div>
                  {fs.status === "uploading" && (
                    <div className="w-20">
                      <Progress className="h-1.5" value={undefined} />
                    </div>
                  )}
                  {statusBadge(fs)}
                  {fs.status === "pending" && (
                    <button
                      onClick={() => removeFile(fs)}
                      className="text-slate-300 hover:text-slate-500"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {fs.meta && (fs.status === "tagged" || fs.status === "review") && (
                  <div className="px-3 pb-3 flex flex-wrap gap-2">
                    {fs.meta.confidenceScore != null && (
                      <Badge
                        className={`text-xs ${
                          fs.meta.confidenceScore >= 0.75
                            ? "bg-green-50 text-green-700 hover:bg-green-50"
                            : "bg-amber-50 text-amber-700 hover:bg-amber-50"
                        }`}
                      >
                        {Math.round(fs.meta.confidenceScore * 100)}% confidence
                      </Badge>
                    )}
                    {fs.meta.policyDomain && (
                      <Badge variant="outline" className="text-xs">
                        {fs.meta.policyDomain}
                      </Badge>
                    )}
                    {fs.meta.documentType && (
                      <Badge variant="outline" className="text-xs">
                        {fs.meta.documentType}
                      </Badge>
                    )}
                    {fs.meta.audience && (
                      <Badge variant="outline" className="text-xs">
                        {fs.meta.audience}
                      </Badge>
                    )}
                    {fs.meta.issuingAuthority && (
                      <Badge variant="outline" className="text-xs text-slate-500">
                        {fs.meta.issuingAuthority}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {pendingCount > 0 && (
        <Button
          className="w-full"
          size="lg"
          onClick={uploadAll}
          disabled={isUploading}
        >
          {isUploading ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Upload className="w-4 h-4 mr-2" />
          )}
          Upload {pendingCount} file{pendingCount > 1 ? "s" : ""}
        </Button>
      )}
    </div>
  );
}
