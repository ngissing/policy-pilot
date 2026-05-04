import { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Settings,
  MessageSquare,
  BookOpen,
  Lightbulb,
  AlertCircle,
  Save,
  RotateCcw,
  Loader2,
  RefreshCw,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface AppSettings {
  id: number;
  responseLength: string;
  responseTone: string;
  maxSources: number;
  showFollowUpSuggestions: boolean;
  fallbackMessage: string;
  updatedAt: string;
}

interface RegenStatus {
  running: boolean;
  total: number;
  done: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
}

const DEFAULTS: Omit<AppSettings, "id" | "updatedAt"> = {
  responseLength: "detailed",
  responseTone: "formal",
  maxSources: 5,
  showFollowUpSuggestions: true,
  fallbackMessage:
    "I couldn't find a policy that covers this — consider uploading relevant documents.",
};

function OptionCard({
  selected,
  onClick,
  title,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-lg border-2 px-4 py-3 transition-all",
        selected
          ? "border-blue-500 bg-blue-50"
          : "border-slate-200 hover:border-slate-300 bg-white"
      )}
    >
      <p className={cn("text-sm font-medium", selected ? "text-blue-700" : "text-slate-800")}>
        {title}
      </p>
      <p className={cn("text-xs mt-0.5", selected ? "text-blue-600" : "text-slate-500")}>
        {description}
      </p>
    </button>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<Omit<AppSettings, "id" | "updatedAt">>(DEFAULTS);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  // Wiki regeneration state
  const [regenStatus, setRegenStatus] = useState<RegenStatus | null>(null);
  const [startingRegen, setStartingRegen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPolling = () => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status = await apiFetch<RegenStatus>("/documents/wiki-regen-status");
        setRegenStatus(status);
        if (!status.running) stopPolling();
      } catch {
        stopPolling();
      }
    }, 2500);
  };

  useEffect(() => {
    // Check if a job is already running on mount
    apiFetch<RegenStatus>("/documents/wiki-regen-status")
      .then((status) => {
        setRegenStatus(status);
        if (status.running) startPolling();
      })
      .catch(() => {});
    return stopPolling;
  }, []);

  async function handleRegenAll() {
    setStartingRegen(true);
    try {
      const res = await apiFetch<{ message: string; total: number }>(
        "/documents/regenerate-all-wikis",
        { method: "POST" }
      );
      toast({ title: `Regenerating ${res.total} wiki pages…`, description: "This may take a few minutes." });
      const status = await apiFetch<RegenStatus>("/documents/wiki-regen-status");
      setRegenStatus(status);
      startPolling();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to start regeneration";
      toast({ title: "Could not start regeneration", description: msg, variant: "destructive" });
    } finally {
      setStartingRegen(false);
    }
  }

  useEffect(() => {
    apiFetch<AppSettings>("/settings")
      .then((data) => {
        setSettings({
          responseLength: data.responseLength,
          responseTone: data.responseTone,
          maxSources: data.maxSources,
          showFollowUpSuggestions: data.showFollowUpSuggestions,
          fallbackMessage: data.fallbackMessage,
        });
        setLastSaved(new Date(data.updatedAt));
      })
      .catch(() => toast({ title: "Failed to load settings", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await apiFetch<AppSettings>("/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      setLastSaved(new Date(updated.updatedAt));
      toast({ title: "Settings saved" });
    } catch {
      toast({ title: "Failed to save settings", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setSettings(DEFAULTS);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Settings className="w-6 h-6 text-blue-600" />
            Chat Settings
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Configure how the AI assistant responds to policy questions.
            {lastSaved && (
              <span className="ml-2 text-slate-400">
                Last saved {lastSaved.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Response Length */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-blue-500" />
            Response Length
          </CardTitle>
          <CardDescription>
            Control how much detail the AI includes in each answer.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          <OptionCard
            selected={settings.responseLength === "brief"}
            onClick={() => setSettings((s) => ({ ...s, responseLength: "brief" }))}
            title="Brief"
            description="1-2 sentences only — the fastest possible answer."
          />
          <OptionCard
            selected={settings.responseLength === "concise"}
            onClick={() => setSettings((s) => ({ ...s, responseLength: "concise" }))}
            title="Concise"
            description="Bullet points, 3-4 sentences. Best for quick lookups."
          />
          <OptionCard
            selected={settings.responseLength === "detailed"}
            onClick={() => setSettings((s) => ({ ...s, responseLength: "detailed" }))}
            title="Detailed"
            description="Full explanation with context. Best for complex queries."
          />
        </CardContent>
      </Card>

      {/* Response Tone */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-blue-500" />
            Response Tone
          </CardTitle>
          <CardDescription>
            Choose the communication style that suits your school's culture.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <OptionCard
            selected={settings.responseTone === "formal"}
            onClick={() => setSettings((s) => ({ ...s, responseTone: "formal" }))}
            title="Formal"
            description="Professional and precise — appropriate for staff and governance contexts."
          />
          <OptionCard
            selected={settings.responseTone === "friendly"}
            onClick={() => setSettings((s) => ({ ...s, responseTone: "friendly" }))}
            title="Friendly"
            description="Approachable and plain-spoken — easier to read for parents and students."
          />
        </CardContent>
      </Card>

      {/* Max Sources */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-blue-500" />
            Sources Retrieved
          </CardTitle>
          <CardDescription>
            How many policy document sections the AI reviews before answering. More sources means
            broader coverage but slightly slower responses.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          {([3, 5, 10] as const).map((n) => (
            <OptionCard
              key={n}
              selected={settings.maxSources === n}
              onClick={() => setSettings((s) => ({ ...s, maxSources: n }))}
              title={`${n} sections`}
              description={
                n === 3
                  ? "Fastest — focused on top matches"
                  : n === 5
                  ? "Balanced — recommended default"
                  : "Most thorough — wider policy coverage"
              }
            />
          ))}
        </CardContent>
      </Card>

      {/* Follow-up Suggestions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-blue-500" />
            Follow-up Suggestions
          </CardTitle>
          <CardDescription>
            Show suggested follow-up questions after each AI response to help users explore
            related policies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label htmlFor="follow-up-toggle" className="text-sm text-slate-700">
              Show follow-up suggestions
            </Label>
            <Switch
              id="follow-up-toggle"
              checked={settings.showFollowUpSuggestions}
              onCheckedChange={(checked) =>
                setSettings((s) => ({ ...s, showFollowUpSuggestions: checked }))
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Fallback Message */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-blue-500" />
            No-Match Message
          </CardTitle>
          <CardDescription>
            The message shown when no relevant policy documents are found for a question.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={settings.fallbackMessage}
            onChange={(e) =>
              setSettings((s) => ({ ...s, fallbackMessage: e.target.value }))
            }
            rows={3}
            placeholder="Enter the message to show when no policy is found…"
            className="text-sm"
          />
        </CardContent>
      </Card>

      {/* Wiki Knowledge Base */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-violet-500" />
            Wiki Knowledge Base
          </CardTitle>
          <CardDescription>
            Regenerate structured wiki pages for all uploaded documents. Useful after adding new
            documents in bulk or after updating the wiki prompt. Processing runs in batches of 3 —
            this may take a few minutes for large libraries.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            onClick={handleRegenAll}
            disabled={startingRegen || regenStatus?.running}
            variant="outline"
            className="gap-2 border-violet-200 text-violet-700 hover:bg-violet-50 hover:border-violet-300"
          >
            {startingRegen || regenStatus?.running ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {regenStatus?.running
              ? `Regenerating… ${regenStatus.done} / ${regenStatus.total}`
              : "Regenerate All Wiki Pages"}
          </Button>

          {/* Progress bar while running */}
          {regenStatus?.running && regenStatus.total > 0 && (
            <div className="space-y-1.5">
              <Progress
                value={Math.round((regenStatus.done / regenStatus.total) * 100)}
                className="h-2"
              />
              <p className="text-xs text-slate-500">
                {regenStatus.done} of {regenStatus.total} documents processed
                {regenStatus.errors > 0 && (
                  <span className="text-amber-600 ml-2">· {regenStatus.errors} errors</span>
                )}
              </p>
            </div>
          )}

          {/* Completion summary */}
          {regenStatus && !regenStatus.running && regenStatus.finishedAt && (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg px-4 py-3 text-sm",
                regenStatus.errors === 0
                  ? "bg-green-50 border border-green-100 text-green-800"
                  : "bg-amber-50 border border-amber-100 text-amber-800"
              )}
            >
              {regenStatus.errors === 0 ? (
                <CheckCircle className="w-4 h-4 shrink-0 mt-0.5 text-green-600" />
              ) : (
                <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              )}
              <span>
                Last run completed:{" "}
                <strong>
                  {regenStatus.done} wiki page{regenStatus.done !== 1 ? "s" : ""} updated
                </strong>
                {regenStatus.errors > 0 && `, ${regenStatus.errors} failed`}.
                Finished at{" "}
                {new Date(regenStatus.finishedAt).toLocaleTimeString("en-AU")}.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex items-center gap-3 pb-8">
        <Button onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
          {saving ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          Save Settings
        </Button>
        <Button variant="outline" onClick={handleReset} disabled={saving}>
          <RotateCcw className="w-4 h-4 mr-2" />
          Reset to Defaults
        </Button>
      </div>
    </div>
  );
}
