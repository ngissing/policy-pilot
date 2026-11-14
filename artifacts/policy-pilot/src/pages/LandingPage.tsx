import {
  Shield,
  MessageSquare,
  BookOpen,
  Globe,
  Upload,
  Zap,
  CheckCircle,
  ArrowRight,
} from "lucide-react";

const FEATURES = [
  {
    icon: Upload,
    color: "bg-blue-500",
    title: "Instant Document Ingestion",
    desc: "Upload PDFs, DOCX, and TXT files — or crawl education portals directly. Every document is parsed and ready in seconds.",
  },
  {
    icon: Zap,
    color: "bg-violet-500",
    title: "AI Auto-Tagging",
    desc: "Claude AI reads each policy and automatically assigns domain, document type, issuing authority, audience, and confidence score — no manual work needed.",
  },
  {
    icon: MessageSquare,
    color: "bg-emerald-500",
    title: "Policy Chat with Citations",
    desc: "Ask any question in plain English. Get accurate answers drawn directly from your policy library, with citations linking back to the source.",
  },
  {
    icon: Globe,
    color: "bg-amber-500",
    title: "Web Scraper",
    desc: "Crawl VIC, NSW, QLD, and SA education portals automatically. New policies are imported, tagged, and indexed without lifting a finger.",
  },
  {
    icon: BookOpen,
    color: "bg-rose-500",
    title: "Searchable Policy Library",
    desc: "Filter by domain, document type, audience, issuing authority, and status. Find exactly the policy you need in seconds, not hours.",
  },
  {
    icon: Shield,
    color: "bg-slate-500",
    title: "Admin Review Queue",
    desc: "Low-confidence AI tags surface in a dedicated review queue so your team can verify and approve before policies go live.",
  },
];

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Upload or scrape",
    desc: "Add your school and department policies by uploading files or crawling government education portals.",
  },
  {
    step: "02",
    title: "AI tags everything",
    desc: "Claude AI reads each document and applies domain, type, audience, and issuing authority tags automatically.",
  },
  {
    step: "03",
    title: "Chat and search",
    desc: "Ask questions in plain English and get cited answers from your library — scoped to school, department, or a specific domain.",
  },
];

export default function LandingPage({ onSignIn }: { onSignIn: () => void }) {

  return (
    <div className="min-h-screen bg-slate-950 text-white">

      {/* Nav */}
      <header className="border-b border-white/10 sticky top-0 z-40 bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-500 flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg">PolicyPilot</span>
          </div>
          <button
            onClick={onSignIn}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-semibold transition-colors"
          >
            Sign in
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-600/20 via-transparent to-violet-600/10 pointer-events-none" />
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-20 -left-20 w-72 h-72 bg-violet-600/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-36 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-300 text-xs font-semibold mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            Built for Australian K–12 Schools
          </div>

          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight leading-tight mb-6">
            Policy intelligence,
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-violet-400">
              powered by AI
            </span>
          </h1>

          <p className="text-slate-400 text-xl max-w-2xl mx-auto mb-10 leading-relaxed">
            Upload school and department policies, let AI tag and index them, then ask
            any question in plain English — with cited answers in seconds.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onSignIn}
              className="flex items-center gap-2 px-7 py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 font-semibold text-base transition-all shadow-lg shadow-blue-900/40 hover:shadow-blue-600/30"
            >
              Get started free
              <ArrowRight className="w-4 h-4" />
            </button>
            <a
              href="#features"
              className="px-7 py-3.5 rounded-xl border border-white/10 hover:bg-white/5 font-semibold text-base text-slate-300 transition-colors"
            >
              See features
            </a>
          </div>

          {/* Stats strip */}
          <div className="mt-20 grid grid-cols-3 gap-8 max-w-lg mx-auto border-t border-white/10 pt-10">
            {[
              { value: "< 10s", label: "AI tagging per doc" },
              { value: "8+", label: "Policy domains" },
              { value: "4 states", label: "Education portals" },
            ].map(({ value, label }) => (
              <div key={label}>
                <p className="text-2xl font-bold text-white">{value}</p>
                <p className="text-xs text-slate-500 mt-1">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 border-t border-white/5">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold mb-4">Everything your school needs</h2>
            <p className="text-slate-400 max-w-xl mx-auto">
              From ingestion to intelligent search — PolicyPilot handles the full policy lifecycle.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map(({ icon: Icon, color, title, desc }) => (
              <div
                key={title}
                className="rounded-2xl border border-white/8 bg-white/3 p-6 hover:bg-white/5 transition-colors group"
              >
                <div className={`w-10 h-10 rounded-xl ${color} flex items-center justify-center mb-4`}>
                  <Icon className="w-5 h-5 text-white" />
                </div>
                <h3 className="font-semibold text-white mb-2">{title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-24 border-t border-white/5 bg-white/2">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold mb-4">Up and running in minutes</h2>
            <p className="text-slate-400 max-w-xl mx-auto">
              No configuration, no training data. Just upload your policies and start asking questions.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 relative">
            <div className="hidden md:block absolute top-8 left-1/3 right-1/3 h-px bg-gradient-to-r from-blue-600/40 to-blue-600/40" />

            {HOW_IT_WORKS.map(({ step, title, desc }) => (
              <div key={step} className="relative text-center">
                <div className="w-16 h-16 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto mb-5">
                  <span className="text-blue-400 font-bold text-lg">{step}</span>
                </div>
                <h3 className="font-semibold text-white text-lg mb-3">{title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Scope filter callout */}
      <section className="py-24 border-t border-white/5">
        <div className="max-w-4xl mx-auto px-6">
          <div className="rounded-2xl border border-blue-500/20 bg-blue-600/10 p-10 md:p-14 text-center">
            <div className="flex justify-center gap-3 mb-6">
              {["All policies", "School policies", "Department policies"].map((label) => (
                <span
                  key={label}
                  className="px-3 py-1.5 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-300 text-xs font-medium"
                >
                  {label}
                </span>
              ))}
            </div>
            <h2 className="text-3xl font-bold mb-4">
              School vs department — always clear
            </h2>
            <p className="text-slate-300 max-w-xl mx-auto leading-relaxed">
              Filter your chat and search by policy scope. Ask about school-level policies only,
              department-issued guidelines, or both — so you always know which authority the answer comes from.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 border-t border-white/5">
        <div className="max-w-2xl mx-auto px-6 text-center">
          <h2 className="text-4xl font-bold mb-5">Ready to simplify policy compliance?</h2>
          <p className="text-slate-400 text-lg mb-10">
            Join schools across Australia using PolicyPilot to find, understand, and apply policies faster.
          </p>
          <button
            onClick={onSignIn}
            className="inline-flex items-center gap-2 px-8 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 font-bold text-lg transition-all shadow-xl shadow-blue-900/40"
          >
            Get started for free
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-slate-500 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-blue-500 flex items-center justify-center">
              <Shield className="w-3 h-3 text-white" />
            </div>
            <span className="font-semibold text-slate-400">PolicyPilot</span>
            <span>— AI policy intelligence for Australian K–12 schools</span>
          </div>
          <div className="flex items-center gap-4">
            {["Student Wellbeing", "Curriculum", "Safety", "Staff & HR"].map((tag) => (
              <span key={tag} className="flex items-center gap-1">
                <CheckCircle className="w-3 h-3 text-blue-500" />
                {tag}
              </span>
            ))}
          </div>
        </div>
      </footer>

    </div>
  );
}
