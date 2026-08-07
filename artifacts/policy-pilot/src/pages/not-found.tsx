import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Shield, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-50">
      <div className="text-center space-y-6 px-4">
        <div className="flex justify-center">
          <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center">
            <Shield className="w-8 h-8 text-white" />
          </div>
        </div>
        <div className="space-y-2">
          <h1 className="text-6xl font-bold text-slate-900">404</h1>
          <p className="text-xl font-medium text-slate-700">Page not found</p>
          <p className="text-slate-500 max-w-sm mx-auto">
            The page you're looking for doesn't exist or may have been moved.
          </p>
        </div>
        <Link href="/">
          <Button variant="default" className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
