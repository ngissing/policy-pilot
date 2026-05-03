import {
  useGetStatsSummary,
  useGetStatsByDomain,
  getGetStatsSummaryQueryKey,
  getGetStatsByDomainQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FileText,
  CheckCircle,
  Clock,
  BarChart3,
  MessageSquare,
  AlertCircle,
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

export default function Dashboard() {
  const { data: summary } = useGetStatsSummary({
    query: { queryKey: getGetStatsSummaryQueryKey(), refetchInterval: 10000 },
  });

  const { data: domainStats = [] } = useGetStatsByDomain({
    query: { queryKey: getGetStatsByDomainQueryKey(), refetchInterval: 10000 },
  });

  const cards = [
    {
      label: "Total Documents",
      value: summary?.total ?? "—",
      icon: FileText,
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    {
      label: "Approved",
      value: summary?.approved ?? "—",
      icon: CheckCircle,
      color: "text-green-600",
      bg: "bg-green-50",
    },
    {
      label: "Needs Review",
      value: summary?.pending ?? "—",
      icon: AlertCircle,
      color: "text-amber-600",
      bg: "bg-amber-50",
    },
    {
      label: "Processing",
      value: summary?.processing ?? "—",
      icon: Clock,
      color: "text-slate-500",
      bg: "bg-slate-50",
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => (
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

      {domainStats.length > 0 && (
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

      <Card className="border-blue-100 bg-blue-50/40">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100">
              <MessageSquare className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="font-medium text-slate-800">Policy Chat is ready</p>
              <p className="text-sm text-slate-500">
                Ask questions about your uploaded policies using AI-powered search
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
