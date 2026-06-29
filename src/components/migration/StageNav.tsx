import { Check } from "lucide-react";
import { useMigration } from "@/lib/migration/store";
import { cn } from "@/lib/utils";

export const STAGES = [
  { id: 1, label: "Requirement" },
  { id: 2, label: "Rule Book" },
  { id: 3, label: "AI Analysis" },
  { id: 4, label: "Power Query" },
  { id: 5, label: "Semantic Model" },
  { id: 6, label: "DAX Measures" },
] as const;

interface Props {
  active: number;
  onSelect: (n: number) => void;
}

export function StageNav({ active, onSelect }: Props) {
  const status = useMigration((s) => s.stageStatus);
  const accuracy = useMigration((s) => s.stageAccuracy);

  const completed = STAGES.filter((s) => status[s.id] === "complete").length;
  const overallAcc =
    Object.values(accuracy).filter((a): a is number => typeof a === "number");
  const overall = overallAcc.length
    ? Math.round(overallAcc.reduce((a, b) => a + b, 0) / overallAcc.length)
    : null;

  return (
    <div className="surface-card p-5 mb-8">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Migration Pipeline
          </div>
          <div className="font-display text-lg font-semibold mt-0.5">
            {completed} of 6 stages complete
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Overall Accuracy</div>
          <div className="font-display text-2xl font-bold gradient-text">
            {overall !== null ? `${overall}%` : "—"}
          </div>
        </div>
      </div>

      <div className="relative">
        <div className="absolute top-5 left-0 right-0 h-[2px] bg-border" />
        <div
          className="absolute top-5 left-0 h-[2px] bg-primary transition-all"
          style={{ width: `${(completed / 6) * 100}%` }}
        />
        <div className="relative grid grid-cols-6 gap-2">
          {STAGES.map((s) => {
            const st = status[s.id];
            const isActive = active === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className="flex flex-col items-center gap-2 group"
              >
                <div
                  className={cn(
                    "h-10 w-10 rounded-full grid place-items-center border-2 transition font-semibold text-sm",
                    st === "complete" && "bg-primary border-primary text-primary-foreground",
                    isActive && st !== "complete" && "bg-surface border-primary text-primary",
                    !isActive && st !== "complete" && "bg-surface border-border text-muted-foreground"
                  )}
                >
                  {st === "complete" ? <Check className="h-4 w-4" /> : s.id}
                </div>
                <div className="text-center">
                  <div
                    className={cn(
                      "text-xs font-medium leading-tight",
                      isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                    )}
                  >
                    {s.label}
                  </div>
                  {accuracy[s.id] !== null && (
                    <div className="text-[10px] text-primary font-semibold mt-0.5">
                      {accuracy[s.id]}%
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
