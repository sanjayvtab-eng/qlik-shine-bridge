import { useRef, useState } from "react";
import JSZip from "jszip";
import { FileUp, Upload, FolderOpen, Archive, X, FileCode, File } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ExtractedFile {
  path: string;
  name: string;
  extension: string;
  sizeKb: number;
  text: string | null;  // null for binary files
  parsedAsText: boolean;
}

interface Props {
  onFiles: (files: ExtractedFile[]) => void;
}

const TEXT_EXTENSIONS = new Set([".qvs", ".txt", ".csv", ".tsv", ".md", ".json", ".xml", ".yaml", ".yml", ".sql", ".js", ".ts", ".py"]);

function isTextFile(ext: string) {
  return TEXT_EXTENSIONS.has(ext.toLowerCase());
}

export function MultiFileDropzone({ onFiles }: Props) {
  const inputFileRef = useRef<HTMLInputElement>(null);
  const inputFolderRef = useRef<HTMLInputElement>(null);
  const inputZipRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [summary, setSummary] = useState<{ total: number; text: number } | null>(null);

  const processFiles = async (rawFiles: File[]) => {
    setProcessing(true);
    const result: ExtractedFile[] = [];

    for (const file of rawFiles) {
      const ext = "." + file.name.split(".").pop()!.toLowerCase();

      if (ext === ".zip") {
        // Extract ZIP contents
        try {
          const zip = await JSZip.loadAsync(file);
          for (const [path, zipEntry] of Object.entries(zip.files)) {
            if (zipEntry.dir) continue;
            const entryExt = "." + path.split(".").pop()!.toLowerCase();
            const sizeKb = parseFloat(((zipEntry as any)._data?.uncompressedSize / 1024 || 0).toFixed(2));
            let text: string | null = null;
            if (isTextFile(entryExt)) {
              text = await zipEntry.async("text");
            }
            result.push({
              path,
              name: path.split("/").pop()!,
              extension: entryExt,
              sizeKb,
              text,
              parsedAsText: text !== null,
            });
          }
        } catch (e) {
          console.warn("Failed to parse ZIP:", file.name, e);
        }
      } else {
        // Regular file
        const sizeKb = parseFloat((file.size / 1024).toFixed(2));
        let text: string | null = null;
        if (isTextFile(ext)) {
          text = await file.text();
        }
        result.push({
          path: (file as any).webkitRelativePath || file.name,
          name: file.name,
          extension: ext,
          sizeKb,
          text,
          parsedAsText: text !== null,
        });
      }
    }

    setSummary({ total: result.length, text: result.filter((f) => f.parsedAsText).length });
    onFiles(result);
    setProcessing(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) processFiles(files);
  };

  return (
    <div className="space-y-4">
      {/* Main drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "rounded-2xl border-2 border-dashed transition-all px-6 py-12 text-center",
          dragging ? "border-primary bg-accent/30" : "border-border bg-surface-elevated"
        )}
      >
        <div className="grid place-items-center h-14 w-14 rounded-xl bg-surface border border-border mx-auto mb-4 shadow-sm">
          {processing
            ? <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            : <FileUp className="h-6 w-6 text-primary" />
          }
        </div>
        <div className="font-semibold text-lg mb-1">
          {processing ? "Extracting files…" : "Drag & drop files, ZIP, or folder here"}
        </div>
        <div className="text-xs text-muted-foreground font-mono mb-6">
          Accepts .qvs · .csv · .txt · .zip · folders
        </div>

        {/* 3 action buttons */}
        <div className="flex flex-wrap justify-center gap-3">
          <button
            onClick={() => inputFileRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/80 transition"
          >
            <Upload className="h-4 w-4" /> Browse Files
          </button>
          <button
            onClick={() => inputFolderRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/80 transition"
          >
            <FolderOpen className="h-4 w-4" /> Upload Folder
          </button>
          <button
            onClick={() => inputZipRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 border border-primary/30 text-primary text-sm font-medium hover:bg-primary/20 transition"
          >
            <Archive className="h-4 w-4" /> Upload ZIP
          </button>
        </div>

        {/* Hidden inputs */}
        <input
          ref={inputFileRef}
          type="file"
          className="hidden"
          multiple
          accept=".qvs,.txt,.csv,.json,.xml,.sql,.py,.ts,.js,.yaml,.yml,.md,.tsv"
          onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) processFiles(files); e.target.value = ""; }}
        />
        <input
          ref={inputFolderRef}
          type="file"
          className="hidden"
          // @ts-ignore — webkitdirectory is a valid attribute
          webkitdirectory=""
          multiple
          onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) processFiles(files); e.target.value = ""; }}
        />
        <input
          ref={inputZipRef}
          type="file"
          className="hidden"
          accept=".zip"
          onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) processFiles(files); e.target.value = ""; }}
        />
      </div>

      {summary && (
        <div className="text-xs text-muted-foreground flex items-center gap-2 bg-surface-elevated p-2 rounded-lg border border-border">
          <FileCode className="h-3.5 w-3.5 text-success" />
          <span className="font-mono font-medium">{summary.total} files extracted</span>
          <span className="text-muted-foreground/60">·</span>
          <span>{summary.text} parsed as text</span>
        </div>
      )}
    </div>
  );
}

// ─── File Analysis Panel ─────────────────────────────────────────────────────

interface FileAnalysisPanelProps {
  files: ExtractedFile[];
  onSelectSource: (file: ExtractedFile) => void;
  onSelectEtl: (file: ExtractedFile) => void;
  selectedSource: ExtractedFile | null;
  selectedEtl: ExtractedFile | null;
}

export function FileAnalysisPanel({
  files,
  onSelectSource,
  onSelectEtl,
  selectedSource,
  selectedEtl,
}: FileAnalysisPanelProps) {
  const qvsFiles = files.filter((f) => f.extension === ".qvs");
  const csvFiles = files.filter((f) => f.extension === ".csv");
  const otherFiles = files.filter((f) => f.extension !== ".qvs" && f.extension !== ".csv");

  const stats = [
    { label: "Total Files", value: files.length },
    { label: "QVS Scripts", value: qvsFiles.length },
    { label: "CSV / Data", value: csvFiles.length },
    { label: "Text Parsed", value: files.filter((f) => f.parsedAsText).length },
  ];

  return (
    <div className="space-y-5">
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="surface-card p-4 text-center">
            <div className="font-display font-black text-3xl text-foreground">{s.value}</div>
            <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Proactive QVS picker */}
      {qvsFiles.length > 0 && (
        <div className="surface-card p-5 space-y-3">
          <div className="font-semibold text-sm">Proactive QVS Assignment</div>
          <p className="text-xs text-muted-foreground">
            Click to assign which QVS file is the <span className="text-primary font-medium">Source script</span> and which is the <span className="text-warning font-medium">ETL script</span>.
          </p>
          <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
            {qvsFiles.map((f) => {
              const isSource = selectedSource?.path === f.path;
              const isEtl = selectedEtl?.path === f.path;
              return (
                <div key={f.path} className="flex items-center gap-3 px-4 py-3 bg-surface-elevated hover:bg-accent/20 transition">
                  <FileCode className="h-4 w-4 text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs font-medium truncate">{f.path}</div>
                    <div className="text-[10px] text-muted-foreground">{f.sizeKb} KB</div>
                  </div>
                  <button
                    onClick={() => onSelectSource(f)}
                    className={cn(
                      "px-3 py-1 rounded-lg text-xs font-medium transition",
                      isSource ? "bg-primary text-primary-foreground" : "bg-accent text-accent-foreground hover:bg-primary/20"
                    )}
                  >
                    {isSource ? "✓ Source" : "Set Source"}
                  </button>
                  <button
                    onClick={() => onSelectEtl(f)}
                    className={cn(
                      "px-3 py-1 rounded-lg text-xs font-medium transition",
                      isEtl ? "bg-warning text-warning-foreground" : "bg-accent text-accent-foreground hover:bg-warning/20"
                    )}
                  >
                    {isEtl ? "✓ ETL" : "Set ETL"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* All files table */}
      <div className="surface-card overflow-hidden">
        <div className="px-5 py-3 border-b border-border font-semibold text-sm">Files available in uploaded package</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-surface-elevated">
                <th className="px-4 py-2.5 text-left text-muted-foreground font-medium">Path</th>
                <th className="px-4 py-2.5 text-left text-muted-foreground font-medium">Extension</th>
                <th className="px-4 py-2.5 text-left text-muted-foreground font-medium">Size KB</th>
                <th className="px-4 py-2.5 text-center text-muted-foreground font-medium">Parsed as text</th>
                <th className="px-4 py-2.5 text-left text-muted-foreground font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {files.map((f) => {
                const isSource = selectedSource?.path === f.path;
                const isEtl = selectedEtl?.path === f.path;
                return (
                  <tr key={f.path} className={cn(
                    "hover:bg-accent/10 transition",
                    isSource && "bg-primary/5",
                    isEtl && "bg-warning/5",
                  )}>
                    <td className="px-4 py-2 font-mono text-foreground truncate max-w-[280px]">
                      {isSource && <span className="text-primary mr-1.5 font-bold">[SRC]</span>}
                      {isEtl && <span className="text-warning mr-1.5 font-bold">[ETL]</span>}
                      {f.path}
                    </td>
                    <td className="px-4 py-2 font-mono text-muted-foreground">{f.extension}</td>
                    <td className="px-4 py-2 text-muted-foreground">{f.sizeKb}</td>
                    <td className="px-4 py-2 text-center">
                      {f.parsedAsText
                        ? <span className="inline-block h-3.5 w-3.5 rounded bg-success/20 border border-success/40" />
                        : <span className="inline-block h-3.5 w-3.5 rounded bg-muted border border-border" />
                      }
                    </td>
                    <td className="px-4 py-2 text-muted-foreground/70 italic">
                      {!f.parsedAsText ? "Binary/metadata retained in inventory" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
