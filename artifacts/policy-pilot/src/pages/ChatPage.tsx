import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MessageSquare,
  Send,
  Plus,
  Bot,
  User,
  FileText,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface Citation {
  documentId: number;
  filename: string;
  excerpt: string;
}

interface ChatMessage {
  id: number;
  sessionId: number;
  role: string;
  content: string;
  citations?: Citation[] | null;
  createdAt: string;
}

interface ChatSession {
  id: number;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages?: ChatMessage[];
}

export default function ChatPage() {
  const [activeSession, setActiveSession] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: sessions = [] } = useQuery<ChatSession[]>({
    queryKey: ["chat-sessions"],
    queryFn: () => apiFetch("/chat/sessions"),
  });

  const { data: session } = useQuery<ChatSession>({
    queryKey: ["chat-session", activeSession],
    queryFn: () => apiFetch(`/chat/sessions/${activeSession}`),
    enabled: activeSession !== null,
    refetchInterval: false,
  });

  const newSession = useMutation({
    mutationFn: () => apiFetch<ChatSession>("/chat/sessions", { method: "POST", body: JSON.stringify({ title: "New Chat" }) }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["chat-sessions"] });
      setActiveSession(s.id);
    },
  });

  const sendMessage = useMutation({
    mutationFn: ({ sessionId, question }: { sessionId: number; question: string }) =>
      apiFetch<ChatMessage>(`/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ question }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat-session", activeSession] });
      qc.invalidateQueries({ queryKey: ["chat-sessions"] });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages]);

  const handleSend = async () => {
    if (!input.trim()) return;
    let sid = activeSession;
    if (!sid) {
      const s = await newSession.mutateAsync();
      sid = s.id;
    }
    const q = input.trim();
    setInput("");
    await sendMessage.mutateAsync({ sessionId: sid, question: q });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const messages = session?.messages ?? [];

  return (
    <div className="flex h-[calc(100vh-120px)] gap-4">
      <aside className="w-64 shrink-0 flex flex-col gap-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => newSession.mutate()}
          disabled={newSession.isPending}
        >
          <Plus className="w-4 h-4" />
          New Chat
        </Button>
        <ScrollArea className="flex-1">
          <div className="space-y-1">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSession(s.id)}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors truncate",
                  activeSession === s.id
                    ? "bg-blue-50 text-blue-700 font-medium"
                    : "text-slate-600 hover:bg-slate-100"
                )}
              >
                <MessageSquare className="w-3.5 h-3.5 inline mr-2 opacity-60" />
                {s.title}
              </button>
            ))}
          </div>
        </ScrollArea>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <ScrollArea className="flex-1 pr-2">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-20 text-center text-slate-400">
              <Bot className="w-12 h-12 mb-3 opacity-40" />
              <p className="font-medium text-slate-600">Ask about school policies</p>
              <p className="text-sm mt-1">
                I'll search your policy library and cite specific documents
              </p>
              <div className="mt-4 grid grid-cols-1 gap-2 text-left w-full max-w-sm">
                {[
                  "What is the attendance policy?",
                  "How should I handle a student wellbeing concern?",
                  "What are the data privacy requirements for staff?",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => { setInput(q); }}
                    className="px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-600 text-left hover:bg-slate-50 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "flex gap-3",
                    msg.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  {msg.role === "assistant" && (
                    <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mt-1">
                      <Bot className="w-4 h-4 text-white" />
                    </div>
                  )}
                  <div className={cn("max-w-[75%] space-y-2", msg.role === "user" && "items-end")}>
                    <div
                      className={cn(
                        "rounded-2xl px-4 py-3 text-sm leading-relaxed",
                        msg.role === "user"
                          ? "bg-blue-600 text-white rounded-tr-sm"
                          : "bg-white border border-slate-200 text-slate-800 rounded-tl-sm shadow-sm"
                      )}
                    >
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                    {msg.citations && msg.citations.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-xs text-slate-400 ml-1">Sources:</p>
                        {msg.citations.map((c, i) => (
                          <Card key={i} className="border-slate-100">
                            <CardContent className="py-2 px-3">
                              <div className="flex items-start gap-2">
                                <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                                <div className="min-w-0">
                                  <p className="text-xs font-medium text-slate-700 truncate">
                                    {c.filename}
                                  </p>
                                  <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">
                                    {c.excerpt}
                                  </p>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                  {msg.role === "user" && (
                    <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center shrink-0 mt-1">
                      <User className="w-4 h-4 text-slate-600" />
                    </div>
                  )}
                </div>
              ))}
              {sendMessage.isPending && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                    <Bot className="w-4 h-4 text-white" />
                  </div>
                  <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                    <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </ScrollArea>

        <div className="mt-3 flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about a school policy… (Enter to send)"
            rows={2}
            className="resize-none"
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || sendMessage.isPending}
            size="icon"
            className="h-10 w-10 shrink-0"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
