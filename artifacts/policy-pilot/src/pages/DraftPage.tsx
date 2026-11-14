import { trackEvent } from "@/lib/analytics";
import { useState, useEffect, useRef } from "react";
import { apiFetch, apiFetchStream } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ReactMarkdown from "react-markdown";
import {
  PenLine,
  Wand2,
  Loader2,
  Copy,
  Download,
  BookmarkPlus,
  Cloud,
  HardDrive,
  Lock,
  CheckCircle,
  AlertCircle,
  School,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface AppSettings {
  aiProvider: string;
  schoolName?: string | null;
  schoolType?: string | null;
}

interface DraftMeta {
  topic: string;
  useSchoolContext: boolean;
  provider: string;
  sources: string[];
}

function BlinkingCursor() {
  return (
    <span className="inline-block w-0.5 h-4 bg-slate-600 ml-0.5 align-middle animate-pulse" />
  );
}

export default function DraftPage() {
  const { toast } = useToast();

  // Settings
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const isOffline = settings?.aiProvider === "offline";

  // Form state
  const [topic, setTopic] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [useSchoolContext, setUseSchoolContext] = useState(false);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [draftMeta, setDraftMeta] = useState<DraftMeta | null>(null);
  const [finalDraft, setFinalDraft] = useState("");
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [savedDocId, setSavedDocId] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    apiFetch<AppSettings>("/settings")
      .then((s) => setSettings(s))
      .catch(() => {});
    return () => abortRef.current?.abort();
  }, []);

  async function handleGenerate() {
    if (!topic.trim() || isGenerating) return;

    trackEvent("draft_generation_started", { school_context: useSchoolContext });
    setIsGenerating(true);
    setStreamingText("");
    setFinalDraft("");
    setDraftMeta(null);
    setSavedDocId(null);

    abortRef.current = new AbortController();

    try {
      const res = await apiFetchStream("/draft/generate", {
        method: "POST",
        body: JSON.stringify({ topic: topic.trim(), additionalContext, useSchoolContext }),
        signal: abortRef.current.signal,
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let event = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            event = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
            } catch {
              event = "";
              continue;
            }
            // Handle error OUTSIDE the JSON parse try-catch so it propagates correctly
            if (event === "error") {
              throw new Error((payload.error as string) ?? "Generation failed");
            } else if (event === "meta") {
              setDraftMeta(payload as unknown as DraftMeta);
            } else if (event === "token") {
              setStreamingText((prev) => prev + ((payload.text as string) ?? ""));
            } else if (event === "done") {
              trackEvent("draft_generation_completed", { school_context: useSchoolContext });
              setFinalDraft((payload.text as string) ?? "");
              setStreamingText("");
            }
            event = "";
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") return;
      trackEvent("draft_generation_failed", { school_context: useSchoolContext });
      const msg = (err as Error).message ?? "Failed to generate draft";
      toast({ title: "Draft generation failed", description: msg, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  }

  function handleCopy() {
    const text = finalDraft || streamingText;
    navigator.clipboard.writeText(text).then(() =>
      toast({ title: "Copied to clipboard" })
    );
  }

  function handleDownload() {
    const text = finalDraft || streamingText;
    const slug = topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug || "policy-draft"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSaveToLibrary() {
    const text = finalDraft || streamingText;
    if (!text) return;
    setSavingToLibrary(true);
    try {
      const res = await apiFetch<{ id: number; filename: string; status: string }>(
        "/draft/save",
        {
          method: "POST",
          body: JSON.stringify({ content: text, title: topic.trim() }),
        }
      );
      setSavedDocId(res.id);
      trackEvent("draft_saved_to_library");
      toast({
        title: "Saved to library",
        description: `"${res.filename}" has been added to the Review Queue for approval.`,
      });
    } catch (err: unknown) {
      toast({
        title: "Failed to save",
        description: (err as Error).message,
        variant: "destructive",
      });
    } finally {
      setSavingToLibrary(false);
    }
  }

  const hasDraft = !!(finalDraft || streamingText);
  const displayText = streamingText || finalDraft;

  return (
    <div className="max-w-4xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <PenLine className="w-6 h-6 text-blue-600" />
          Policy Drafter
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Generate a complete, ready-to-use policy document grounded in your existing library and
          PAL policies.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ── Left: Topic form ──────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Policy Topic</CardTitle>
              <CardDescription>
                Describe the policy you want to draft. Be specific — e.g.{" "}
                <em>"Student Mobile Phone Use"</em> rather than just{" "}
                <em>"Technology"</em>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="topic">Topic *</Label>
                <Input
                  id="topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. Student Mobile Phone Use Policy"
                  disabled={isGenerating}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleGenerate();
                    }
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="context">Additional Context (optional)</Label>
                <Textarea
                  id="context"
                  value={additionalContext}
                  onChange={(e) => setAdditionalContext(e.target.value)}
                  placeholder="Any specific requirements, local rules, incident background, or guidance you want the draft to address…"
                  rows={4}
                  disabled={isGenerating}
                  className="text-sm resize-none"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Right: Options ────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Generation Options</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* AI Provider badge */}
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-500 uppercase tracking-wide">
                  AI Provider
                </Label>
                {settings ? (
                  <div className="flex items-center gap-2">
                    {isOffline ? (
                      <>
                        <HardDrive className="w-4 h-4 text-emerald-600" />
                        <Badge
                          variant="outline"
                          className="border-emerald-200 text-emerald-700 bg-emerald-50"
                        >
                          Offline (Ollama)
                        </Badge>
                      </>
                    ) : (
                      <>
                        <Cloud className="w-4 h-4 text-blue-500" />
                        <Badge
                          variant="outline"
                          className="border-blue-200 text-blue-700 bg-blue-50"
                        >
                          Cloud (Anthropic)
                        </Badge>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="h-6 w-28 bg-slate-100 rounded animate-pulse" />
                )}
              </div>

              {/* School context toggle */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <School className="w-4 h-4 text-slate-500" />
                    <Label
                      htmlFor="school-ctx"
                      className={cn(
                        "text-sm font-medium",
                        !isOffline && "text-slate-400"
                      )}
                    >
                      Include school context
                    </Label>
                  </div>
                  {isOffline ? (
                    <Switch
                      id="school-ctx"
                      checked={useSchoolContext}
                      onCheckedChange={setUseSchoolContext}
                      disabled={isGenerating}
                    />
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-1 text-slate-400">
                          <Lock className="w-3.5 h-3.5" />
                          <Switch id="school-ctx" checked={false} disabled />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-[220px] text-xs">
                        School-specific drafting requires the offline AI provider.
                        Switch to <strong>Offline</strong> in Settings → AI Provider
                        to use this feature.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                {isOffline && useSchoolContext && (
                  <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md px-3 py-2">
                    Your school profile will be included. The draft stays on your
                    local Ollama model — nothing is sent to a cloud API.
                  </p>
                )}
                {!isOffline && (
                  <p className="text-xs text-slate-400">
                    School context is locked to offline mode to protect sensitive
                    school data.
                  </p>
                )}
              </div>

              {/* Source count note */}
              {draftMeta && (
                <div className="text-xs text-slate-500 space-y-1 border-t border-slate-100 pt-3">
                  <p className="font-medium text-slate-600">Sources used</p>
                  {draftMeta.sources.length > 0 ? (
                    <ul className="space-y-0.5">
                      {draftMeta.sources.map((s, i) => (
                        <li key={i} className="truncate" title={s}>
                          · {s}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No matching policies found — drafted from best practice.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Generate button */}
          <Button
            className="w-full bg-blue-600 hover:bg-blue-700 gap-2"
            onClick={handleGenerate}
            disabled={!topic.trim() || isGenerating}
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4" />
                Generate Draft
              </>
            )}
          </Button>
        </div>
      </div>

      {/* ── Draft output ──────────────────────────────────────────────────────── */}
      {(isGenerating && !displayText) && (
        <Card>
          <CardContent className="py-8 flex items-center justify-center gap-3 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">
              Searching library and drafting policy…
            </span>
          </CardContent>
        </Card>
      )}

      {hasDraft && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">Generated Draft</CardTitle>
                {draftMeta && (
                  <CardDescription className="mt-0.5">
                    {topic}
                    {draftMeta.useSchoolContext && (
                      <span className="ml-2 text-emerald-600 font-medium">
                        · school context included
                      </span>
                    )}
                  </CardDescription>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs h-8"
                  onClick={handleCopy}
                  disabled={isGenerating}
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs h-8"
                  onClick={handleDownload}
                  disabled={isGenerating}
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </Button>
                {savedDocId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled
                    className="gap-1.5 text-xs h-8 border-emerald-200 text-emerald-700"
                  >
                    <CheckCircle className="w-3.5 h-3.5" />
                    Saved
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-xs h-8 border-violet-200 text-violet-700 hover:bg-violet-50"
                    onClick={handleSaveToLibrary}
                    disabled={isGenerating || savingToLibrary || !finalDraft}
                  >
                    {savingToLibrary ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <BookmarkPlus className="w-3.5 h-3.5" />
                    )}
                    Save to Library
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div
              className="prose prose-sm max-w-none text-slate-800
                prose-headings:font-semibold prose-headings:text-slate-900
                prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
                prose-p:my-1.5 prose-p:leading-relaxed
                prose-ul:my-1.5 prose-ul:pl-4 prose-li:my-0.5
                prose-ol:my-1.5 prose-ol:pl-4
                prose-strong:font-semibold prose-strong:text-slate-900
                prose-hr:border-slate-200
                border rounded-lg bg-white px-6 py-5"
            >
              <ReactMarkdown>{displayText}</ReactMarkdown>
              {isGenerating && <BlinkingCursor />}
            </div>
            {!isGenerating && finalDraft && (
              <p className="text-xs text-slate-400 mt-3 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                Review this draft carefully before publishing. AI-generated policy
                documents should be verified against your state's legislation.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
