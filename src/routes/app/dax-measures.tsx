import { createFileRoute } from "@tanstack/react-router";
import { EnterpriseAnalysisPanel } from "@/components/migration/EnterpriseAnalysisPanel";
import { useMigration } from "@/lib/migration/store";

export const Route = createFileRoute("/app/dax-measures")({
  component: AppDaxMeasures,
});

function AppDaxMeasures() {
  const { uploadedFiles } = useMigration();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 px-1">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">DAX Measures Engine</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      
      <EnterpriseAnalysisPanel files={uploadedFiles} activeTabOverride="dax" />
    </div>
  );
}
