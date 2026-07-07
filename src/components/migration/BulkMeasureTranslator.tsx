import { useState } from "react";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Upload, FileSpreadsheet, Loader2, CheckCircle2, XCircle, Copy, Check } from "lucide-react";
import { translateBulkMeasuresViaAi } from "@/lib/migration/gemini";
import { useMigration } from "@/lib/migration/store";
import type { BulkMeasureResult } from "@/lib/migration/types";
import { toast } from "sonner";

export function BulkMeasureTranslator() {
  const { ruleBookMd } = useMigration();
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [results, setResults] = useState<BulkMeasureResult[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const onDrop = async (acceptedFiles: File[]) => {
    const f = acceptedFiles[0];
    if (!f) return;

    // Manual extension check to bypass strict MIME issues on Windows
    const ext = f.name.toLowerCase().split('.').pop();
    if (!['csv', 'xlsx', 'xls'].includes(ext || '')) {
      toast.error("Unsupported file type. Please upload a .csv, .xlsx, or .xls file.");
      return;
    }

    setFile(f);
    setParsing(true);
    setResults([]);

    try {
      const data = await parseFile(f);
      console.log("Parsed Excel/CSV data:", data);
      
      if (!data || data.length === 0) {
        toast.error("No valid rows found in file. Ensure headers contain 'Measure/Name' and 'Expression/Formula'.");
        setParsing(false);
        return;
      }

      setParsing(false);
      setTranslating(true);

      const translated = await translateBulkMeasuresViaAi(data, ruleBookMd || "");
      console.log("Translated results array:", translated);
      
      if (!Array.isArray(translated) || translated.length === 0) {
        toast.error("AI returned empty results. Check console for raw output.");
      } else {
        setResults(translated);
        toast.success(`Successfully translated ${translated.length} measures!`);
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to process file");
    } finally {
      setParsing(false);
      setTranslating(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1
  });

  const parseFile = (file: File): Promise<{ name: string; expression: string }[]> => {
    return new Promise((resolve, reject) => {
      const isCsv = file.name.endsWith(".csv");
      
      const processJson = (json: any[]) => {
        const extracted = json.map(row => {
          // Attempt to find columns matching 'measure', 'name' and 'expression', 'qlik'
          const keys = Object.keys(row);
          const nameKey = keys.find(k => k.toLowerCase().includes("name") || k.toLowerCase().includes("measure"));
          const exprKey = keys.find(k => k.toLowerCase().includes("expression") || k.toLowerCase().includes("qlik") || k.toLowerCase().includes("formula"));
          
          if (nameKey && exprKey) {
            return { name: String(row[nameKey]), expression: String(row[exprKey]) };
          }
          
          // Fallback: just use the first two columns
          if (keys.length >= 2) {
            return { name: String(row[keys[0]]), expression: String(row[keys[1]]) };
          }
          return null;
        }).filter(Boolean) as { name: string; expression: string }[];
        resolve(extracted);
      };

      if (isCsv) {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => processJson(results.data),
          error: (err) => reject(err)
        });
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = new Uint8Array(e.target?.result as ArrayBuffer);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(firstSheet);
            processJson(json);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = (err) => reject(err);
        reader.readAsArrayBuffer(file);
      }
    });
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold tracking-tight">Bulk Translate Expressions</h3>
        <p className="text-sm text-muted-foreground">Upload an Excel (.xlsx) or CSV file containing <strong>Measure Name</strong> and <strong>Qlik Expression</strong> columns.</p>
      </div>

      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer \${
          isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-surface-elevated"
        }`}
      >
        <input {...getInputProps()} />
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 mb-4">
          <Upload className="h-6 w-6 text-primary" />
        </div>
        <div className="font-semibold mb-1">Drag & drop your file here</div>
        <div className="text-sm text-muted-foreground">Supports .csv, .xlsx, .xls</div>
      </div>

      {(parsing || translating) && (
        <div className="flex items-center justify-center p-12 text-muted-foreground gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          {parsing ? "Parsing file..." : "Translating expressions via Gemini AI..."}
        </div>
      )}

      {results.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider bg-surface-elevated border-b border-border">
                <tr>
                  <th className="px-4 py-3">Measure Name</th>
                  <th className="px-4 py-3">Qlik Expression</th>
                  <th className="px-4 py-3">Variables Used</th>
                  <th className="px-4 py-3">Generated DAX</th>
                  <th className="px-4 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {results.map((res, idx) => (
                  <tr key={idx} className="hover:bg-surface-elevated/30 transition-colors">
                    <td className="px-4 py-4 font-medium whitespace-nowrap align-top">{res.measureName}</td>
                    <td className="px-4 py-4 font-mono text-xs text-muted-foreground align-top min-w-[200px]" title={res.qlikExpression}>
                      {res.qlikExpression}
                    </td>
                    <td className="px-4 py-4 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        {res.variablesUsed?.map((v, i) => (
                          <span key={i} className="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-50 text-blue-600 border border-blue-100">
                            {v}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4 align-top w-full">
                      <div className="relative group min-w-[300px]">
                        <pre className="p-3 rounded-lg bg-[#0B1120] text-slate-50 font-mono text-xs overflow-x-auto whitespace-pre-wrap">
                          <code>{res.generatedDax}</code>
                        </pre>
                        <button
                          onClick={() => copyToClipboard(res.generatedDax, idx)}
                          className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white opacity-0 group-hover:opacity-100 transition-opacity text-[10px] border border-white/10"
                          title="Copy DAX"
                        >
                          {copiedIndex === idx ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                          {copiedIndex === idx ? "Copied" : "Copy DAX"}
                        </button>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>Confidence: {res.confidence}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-4 align-top text-center">
                      {res.status === "SUCCESS" ? (
                        <div className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#E6F8ED] text-[#10B981] text-[10px] font-bold tracking-wide border border-[#10B981]/20">
                          SUCCESS
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-50 text-red-700 text-[10px] font-bold tracking-wide border border-red-200">
                          ERROR
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
