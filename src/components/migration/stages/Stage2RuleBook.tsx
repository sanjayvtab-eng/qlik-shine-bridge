import { useState } from "react";
import { useMigration } from "@/lib/migration/store";
import { generateRuleBookViaAi } from "@/lib/migration/gemini";
import { Loader2, Sparkles, FileText, AlertCircle } from "lucide-react";

export function Stage2RuleBook({ onNext }: { onNext: () => void }) {
  const { requirement, ruleBookMd, setMergedMetadata, setStageStatus } = useMigration();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerateRuleBook = async () => {
    if (!requirement) return;
    setLoading(true);
    setError(null);
    setStageStatus(2, "in-progress");

    try {
      const compiledRuleBook = await generateRuleBookViaAi(requirement);
      
      // Save AI Response directly into the main state store
      useMigration.setState({ ruleBookMd: compiledRuleBook });
      
      setStageStatus(2, "complete", 100);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to compile Migration Rule Book via Gemini API.";
      setError(msg);
      setStageStatus(2, "pending");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="surface-card p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h3 className="font-display text-xl font-semibold">AI Rules Compilation Engine</h3>
          <p className="text-sm text-muted-foreground">Analyze business requirements and generate structural mapping rule directives.</p>
        </div>
        <button
          onClick={handleGenerateRuleBook}
          disabled={loading || !requirement}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {loading ? "Compiling Rules..." : ruleBookMd ? "Regenerate Rule Book" : "Generate Rule Book"}
        </button>
      </div>

      {error && (
        <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5 text-sm flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div><span className="font-semibold">API Execution Halted:</span> {error}</div>
        </div>
      )}

      {ruleBookMd && (
        <div className="surface-card p-6 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium border-b pb-3 border-border">
            <FileText className="h-4 w-4 text-primary" /> Active Migration Rule Book Output
          </div>
          <article className="prose prose-sm dark:prose-invert max-w-none overflow-auto max-h-96 font-mono whitespace-pre-wrap p-4 bg-surface-elevated rounded-lg">
            {ruleBookMd}
          </article>
          <div className="flex justify-end pt-2">
            <button onClick={onNext} className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium">
              Advance to Script Ingestion
            </button>
          </div>
        </div>
      )}
    </div>
  );
}