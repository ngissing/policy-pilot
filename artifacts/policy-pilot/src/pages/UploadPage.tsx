import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiUpload } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Upload,
  FileText,
  X,
  CheckCircle,
  AlertCircle,
  CloudUpload,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useDropzone } from "react-dropzone";

interface UploadResult {
  id: number;
  filename: string;
  status: string;
  message: string;
}

interface FileState {
  file: File;
  status: "pending" | "uploading" | "success" | "error";
  result?: UploadResult;
  error?: string;
}

export default function UploadPage() {
  const [files, setFiles] = useState<FileState[]>([]);
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

  const uploadAll = async () => {
    const pending = files.filter((f) => f.status === "pending");
    if (pending.length === 0) return;

    for (const fs of pending) {
      setFiles((prev) =>
        prev.map((f) =>
          f.file === fs.file ? { ...f, status: "uploading" } : f
        )
      );
      try {
        const formData = new FormData();
        formData.append("file", fs.file);
        const result = await apiUpload<UploadResult>("/documents/upload", formData);
        setFiles((prev) =>
          prev.map((f) =>
            f.file === fs.file ? { ...f, status: "success", result } : f
          )
        );
      } catch (err: any) {
        setFiles((prev) =>
          prev.map((f) =>
            f.file === fs.file
              ? { ...f, status: "error", error: err.message }
              : f
          )
        );
      }
    }

    qc.invalidateQueries({ queryKey: ["documents"] });
    qc.invalidateQueries({ queryKey: ["stats"] });
    toast({ title: "Upload complete", description: "AI tagging is running in the background." });
  };

  const removeFile = (f: FileState) => {
    setFiles((prev) => prev.filter((x) => x !== f));
  };

  const pendingCount = files.filter((f) => f.status === "pending").length;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Upload Documents</h1>
        <p className="text-slate-500 mt-1">
          Upload PDF, DOCX, or TXT policy documents. AI will automatically tag
          them with metadata.
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
                  PDF, DOCX, TXT — up to 20MB each
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
          <CardContent className="space-y-2">
            {files.map((fs, i) => (
              <div
                key={i}
                className="flex items-center gap-3 p-2 rounded-lg bg-slate-50"
              >
                <FileText className="w-5 h-5 text-slate-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">
                    {fs.file.name}
                  </p>
                  <p className="text-xs text-slate-400">
                    {(fs.file.size / 1024).toFixed(0)} KB
                  </p>
                </div>
                {fs.status === "uploading" && (
                  <div className="w-20">
                    <Progress className="h-1.5" value={undefined} />
                  </div>
                )}
                {fs.status === "success" && (
                  <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
                )}
                {fs.status === "error" && (
                  <div className="flex items-center gap-1">
                    <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
                    <span className="text-xs text-red-500 max-w-24 truncate">
                      {fs.error}
                    </span>
                  </div>
                )}
                {fs.status === "pending" && (
                  <button
                    onClick={() => removeFile(fs)}
                    className="text-slate-300 hover:text-slate-500"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {pendingCount > 0 && (
        <Button className="w-full" size="lg" onClick={uploadAll}>
          <Upload className="w-4 h-4 mr-2" />
          Upload {pendingCount} file{pendingCount > 1 ? "s" : ""}
        </Button>
      )}
    </div>
  );
}
