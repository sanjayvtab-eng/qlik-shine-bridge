import { Check } from "lucide-react";
import { useMigration } from "@/lib/migration/store";
import { cn } from "@/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";

export const STAGES = [
  { id: 1, label: "Upload & Extract", path: "/app" },
  { id: 2, label: "Enterprise Analysis", path: "/app/analysis" },
  { id: 3, label: "Power Query", path: "/app/power-query" },
  { id: 4, label: "DAX Measures", path: "/app/dax-measures" },
  { id: 5, label: "Model & Export", path: "/app/semantic-model" },
] as const;

export function StageNav() {
  const router = useRouterState();
  const currentPath = router.location.pathname;
  const { enterpriseAnalysis } = useMigration();

  const getStageStatus = (path: string) => {
    if (path === "/app") return currentPath !== "/app" && currentPath !== "/app/" ? "complete" : "active";
    if (path === "/app/analysis") return enterpriseAnalysis !== null ? "complete" : "pending";
    return "pending";
  };

  const activeIndex = STAGES.findIndex(s =>
    s.path === currentPath || (s.path === "/app" && currentPath === "/app/")
  );

  return (
    <div className="surface-card p-5 mb-8">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Migration Pipeline
          </div>
          <div className="font-display text-lg font-semibold mt-0.5">
            {activeIndex >= 0 ? `Stage ${activeIndex + 1} of ${STAGES.length}` : "Migration Engine"}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Status</div>
          <div className="font-display text-lg font-bold gradient-text">
            {enterpriseAnalysis ? `${enterpriseAnalysis.finalTables.length} Tables Ready` : "Awaiting Upload"}
          </div>
        </div>
      </div>

      <div className="relative">
        <div className="absolute top-5 left-0 right-0 h-[2px] bg-border" />
        <div
          className="absolute top-5 left-0 h-[2px] bg-primary transition-all duration-500"
          style={{ width: activeIndex >= 0 ? `${(activeIndex / (STAGES.length - 1)) * 100}%` : "0%" }}
        />
        <div className="relative flex justify-between">
          {STAGES.map((s, i) => {
            const isActive = s.path === currentPath || (s.path === "/app" && currentPath === "/app/");
            const isPast = activeIndex > i;

            return (
              <Link
                key={s.id}
                to={s.path}
                className="flex flex-col items-center gap-2 group"
              >
                <div
                  className={cn(
                    "h-10 w-10 rounded-full grid place-items-center border-2 transition font-semibold text-sm",
                    isPast && "bg-primary border-primary text-primary-foreground",
                    isActive && !isPast && "bg-surface border-primary text-primary",
                    !isActive && !isPast && "bg-surface border-border text-muted-foreground"
                  )}
                >
                  {isPast ? <Check className="h-4 w-4" /> : s.id}
                </div>
                <div className="text-center max-w-[90px]">
                  <div
                    className={cn(
                      "text-xs font-medium leading-tight text-center",
                      isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                    )}
                  >
                    {s.label}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
