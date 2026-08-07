import {
  useGetStatsSummary,
  useGetStatsByDomain,
  getGetStatsSummaryQueryKey,
  getGetStatsByDomainQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  FileText,
  CheckCircle,
  Clock,
  BarChart3,
  MessageSquare,
  AlertCircle,
  Upload,
  Globe,
  ArrowRight,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Link } from "wouter";

const DOMAIN_COLORS: Record<string, string> = {
  "student-wellbeing": "#3b82f6",
  curriculum: "#8b5cf6",
  "staff-hr": "#f59e0b",
  administration: "#6b7280",
  safety: "#ef4444",
  technology: "#06b6d4",
  finance: "#10b981",
  community: "#f97316",
  other: "#94a3b8",
  uncategorized: "#cbd5e1",
};

function StatSkeleton() {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-3">
          <Skeleton className="w-9 h-9 rounded-lg shrink-0" />
          <div className="space-y-1.5">
            <Skeleton className="w-10 h-6" />
            <Skeleton className="w-24 h-3" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: summary, isLoading: summaryLoading } = useGetStatsSummary({
    query: { queryKey: getGetStatsSummaryQueryKey(), refetchInterval: 10000 },
  });

  const { data: domainStats = [], isLoading: domainLoading } = useGetStatsByDomain({
    query: { queryKey: getGetStatsByDomainQueryKey(), refetchInterval: 10000 },
  });

  const isLoading = summaryLoading || domainLoading;
  const hasDocuments = !isLoading && (summary?.total ?? 0) > 0;
  const isEmpty = !isLoading && (summary?.total ?? 0) === 0;

  const cards = [
    {
      label: "Total Documents",
      value: summary?.total ?? 0,
      icon: FileText,
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    {
      label: "Approved",
      value: summary?.approved ?? 0,
      icon: CheckCircle,
      color: "text-green-600",
      bg: "bg-green-50",
    },
    {
      label: "Needs Review",
      value: summary?.pending ?? 0,
      icon: AlertCircle,
      color: "text-amber-600",
      bg: "bg-amber-50",
    },
    {
      label: "Processing",
      value: summary?.processing ?? 0,
      icon: Clock,
      color: "text-slate-500",
      bg: "bg-slate-50",
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => <StatSkeleton key={i} />)
          : cards.map((c) => (
              <Card key={c.label}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${c.bg}`}>
                      <c.icon className={`w-5 h-5 ${c.color}`} />
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-slate-900">{c.value}</p>
                      <p className="text-xs text-slate-500">{c.label}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
      </div>

      {/* First-use empty state */}
      {isEmpty && (
        <Card className="border-dashed border-2 border-slate-200 bg-white">
          <CardContent className="py-10">
            <div className="text-center space-y-4 max-w-md mx-auto">
              <div className="flex justify-center">
                <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center">
                  <FileText className="w-7 h-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Your library is empty</h2>
                <p className="text-sm text-slate-500 mt-1">
                  Add policies to get started. Upload files directly, or let the web scraper pull
                  documents from your department's portal automatically.
                </p>
              </div>
              <div className="flex justify-center gap-3 flex-wrap">
                <Link href="/upload">
                  <Button className="gap-2">
                    <Upload className="w-4 h-4" />
                    Upload policies
                  </Button>
                </Link>
                <Link href="/scrape">
                  <Button variant="outline" className="gap-2">
                    <Globe className="w-4 h-4" />
                    Use web scraper
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Domain breakdown chart */}
      {!isLoading && domainStats.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-slate-400" />
              Documents by Domain
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={domainStats} layout="vertical">
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="domain"
                  width={130}
                  tick={{ fontSize: 12, fill: "#64748b" }}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: "8px",
                    border: "1px solid #e2e8f0",
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {domainStats.map((entry) => (
                    <Cell
                      key={entry.domain}
                      fill={DOMAIN_COLORS[entry.domain] ?? "#94a3b8"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Domain chart skeleton */}
      {isLoading && (
        <Card>
          <CardHeader>
            <Skeleton className="w-40 h-5" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="w-24 h-3" />
                  <Skeleton className="h-5 rounded" style={{ width: `${(4 - i) * 15 + 20}%` }} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Chat prompt card — only shown when there are documents */}
      {hasDocuments && (
        <Card className="border-blue-100 bg-blue-50/40">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-100">
                  <MessageSquare className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="font-medium text-slate-800">Policy Chat is ready</p>
                  <p className="text-sm text-slate-500">
                    Ask any question about your {summary?.total} policies
                  </p>
                </div>
              </div>
              <Link href="/chat">
                <Button size="sm" className="gap-1.5 shrink-0">
                  Ask a question
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
