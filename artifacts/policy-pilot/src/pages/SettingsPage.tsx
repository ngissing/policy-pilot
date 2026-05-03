import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Settings,
  MessageSquare,
  BookOpen,
  Lightbulb,
  AlertCircle,
  Save,
  RotateCcw,
  Loader2,
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
        <CardContent className="grid grid-cols-2 gap-3">
          <OptionCard
            selected={settings.responseLength === "concise"}
            onClick={() => setSettings((s) => ({ ...s, responseLength: "concise" }))}
            title="Concise"
            description="Short, direct answers — bullet points where possible. Best for quick lookups."
          />
          <OptionCard
            selected={settings.responseLength === "detailed"}
            onClick={() => setSettings((s) => ({ ...s, responseLength: "detailed" }))}
            title="Detailed"
            description="Thorough explanations with context and background. Best for complex queries."
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
