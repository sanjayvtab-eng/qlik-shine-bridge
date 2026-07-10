import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMigration } from "@/lib/migration/store";
import { MultiFileDropzone, FileAnalysisPanel } from "@/components/migration/MultiFileDropzone";
import type { ExtractedFile } from "@/components/migration/MultiFileDropzone";
import { PackageOpen, Check, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/app/")({
  component: UploadPage,
});

function UploadPage() {
  const navigate = useNavigate();
  const { setEnterpriseFiles, enterpriseFiles } = useMigration();
  const [allFiles, setAllFiles] = useState<ExtractedFile[]>(enterpriseFiles);
  const [selectedSources, setSelectedSources] = useState<ExtractedFile[]>([]);
  const [selectedEtls, setSelectedEtls] = useState<ExtractedFile[]>([]);

  const handleFiles = (files: ExtractedFile[]) => {
    setAllFiles(files);
    setSelectedSources([]);
    setSelectedEtls([]);
    // Auto-assign
    const textFiles = files.filter((f) => f.parsedAsText);
    const qvsFiles = textFiles.filter((f) => f.extension === ".qvs");
    const pool = qvsFiles.length >= 2 ? qvsFiles : textFiles;
    if (pool.length >= 2) {
      const src = pool.find((f) => !/(etl|main|fact|transform)/i.test(f.name)) ?? pool[0];
      const etl = pool.find((f) => f.path !== src.path) ?? pool[1];
      setSelectedSources([src]);
      setSelectedEtls([etl]);
    } else if (pool.length === 1) {
      setSelectedSources([pool[0]]);
    }
  };

  const canProceed = allFiles.length > 0;

  const handleNext = () => {
    setEnterpriseFiles(allFiles);
    navigate({ to: "/app/analysis" });
  };

  return (
    <div className="space-y-6">
      {/* Upload Section */}
      <div className="surface-card p-6 space-y-4">
        <div className="flex items-start gap-4 mb-2">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-accent text-primary shrink-0">
            <PackageOpen className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-display text-xl font-semibold">Upload &amp; Extraction Engine</h3>
            <p className="text-sm text-muted-foreground">
              Upload individual QVS/CSV files, a ZIP package, or an entire folder. The engine will extract and analyse all contents automatically.
            </p>
          </div>
        </div>
        <MultiFileDropzone onFiles={handleFiles} />
      </div>

      {/* File Analysis Panel */}
      {allFiles.length > 0 && (
        <FileAnalysisPanel
          files={allFiles}
          selectedSources={selectedSources}
          selectedEtls={selectedEtls}
          onToggleSource={(f) => setSelectedSources(prev =>
            prev.some(p => p.path === f.path) ? prev.filter(p => p.path !== f.path) : [...prev, f]
          )}
          onToggleEtl={(f) => setSelectedEtls(prev =>
            prev.some(p => p.path === f.path) ? prev.filter(p => p.path !== f.path) : [...prev, f]
          )}
        />
      )}

      {/* Assigned chips */}
      {(selectedSources.length > 0 || selectedEtls.length > 0) && (
        <div className="flex flex-col gap-2">
          {selectedSources.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-primary/10 border border-primary/30 text-xs font-mono">
              <Check className="h-3.5 w-3.5 text-primary" />
              <span className="text-primary font-semibold">SOURCE:</span>
              <span className="truncate">{selectedSources.map(s => s.name).join(", ")}</span>
            </div>
          )}
          {selectedEtls.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-warning/10 border border-warning/30 text-xs font-mono">
              <Check className="h-3.5 w-3.5 text-warning" />
              <span className="text-warning font-semibold">ETL:</span>
              <span className="truncate">{selectedEtls.map(e => e.name).join(", ")}</span>
            </div>
          )}
        </div>
      )}

      {/* Next Button */}
      <div className="flex justify-end">
        <button
          onClick={handleNext}
          disabled={!canProceed}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm shadow-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          Proceed to Enterprise Analysis <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
