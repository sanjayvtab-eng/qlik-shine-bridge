import { createFileRoute } from "@tanstack/react-router";
import { EnterpriseAnalysisPanel } from "@/components/migration/EnterpriseAnalysisPanel";
import { useMigration } from "@/lib/migration/store";

export const Route = createFileRoute("/app/analysis")({
  component: AppAnalysis,
});

function AppAnalysis() {
  const { uploadedFiles } = useMigration();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 px-1">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Enterprise Analysis Engine</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <p className="text-xs text-center text-muted-foreground max-w-2xl mx-auto px-1">
        Run the initial analysis to generate summary statistics, map your sources, build the pipeline graph, and review the final extracted tables.
      </p>

      {/* Render Summary, Source Mapping, All Tables, Final Tables Tabs */}
      <EnterpriseAnalysisPanel files={uploadedFiles} activeTabOverride="summary" />
      <EnterpriseAnalysisPanel files={uploadedFiles} activeTabOverride="mapping" />
      <EnterpriseAnalysisPanel files={uploadedFiles} activeTabOverride="final" />
    </div>
  );
}
