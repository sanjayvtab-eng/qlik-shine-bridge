import { Check } from "lucide-react";
import { useMigration } from "@/lib/migration/store";
import { cn } from "@/lib/utils";

import { Link, useRouterState } from "@tanstack/react-router";

export const STAGES = [
  { id: 1, label: "Upload & Extract", path: "/app" },
  { id: 2, label: "Enterprise Analysis", path: "/app/analysis" },
  { id: 3, label: "Power Query", path: "/app/power-query" },
  { id: 4, label: "DAX Measures", path: "/app/dax-measures" },
  { id: 5, label: "Semantic Model", path: "/app/semantic-model" },
] as const;

export function StageNav() {
  const router = useRouterState();
  const currentPath = router.location.pathname;
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
            4 Stage Automated Conversion
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
        <div className="relative flex justify-between gap-2 max-w-4xl mx-auto px-4">
          {STAGES.map((s) => {
            const isActive = currentPath === s.path || (s.path === "/app" && currentPath === "/app/");
            const st = status[s.id + 2]; // Map to original stage IDs for accuracy if needed
            
            return (
              <Link
                key={s.id}
                to={s.path}
                className="flex flex-col items-center gap-2 group w-24"
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
                  {accuracy[s.id + 2] !== null && accuracy[s.id + 2] !== undefined && (
                    <div className="text-[10px] text-primary font-semibold mt-0.5">
                      {accuracy[s.id + 2]}%
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
