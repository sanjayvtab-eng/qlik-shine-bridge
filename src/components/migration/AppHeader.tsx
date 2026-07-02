import { Link } from "@tanstack/react-router";
import { MoreHorizontal, ChevronDown, Upload } from "lucide-react";

export function AppHeader() {
  return (
    <header className="sticky top-0 z-40 backdrop-blur-xl bg-background/70 border-b border-border">
      <div className="mx-auto max-w-7xl px-6 py-4 flex items-center gap-8">
        <Link to="/" className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-primary to-[oklch(0.62_0.2_260)] text-primary-foreground font-bold shadow-elevated">
            <span className="text-xs tracking-tight">VT</span>
          </div>
          <div className="leading-tight">
            <div className="font-display font-bold text-sm tracking-wide">VTAB</div>
            <div className="font-display font-bold text-sm tracking-wide -mt-0.5">SQUARE</div>
          </div>
        </Link>
        <nav className="hidden md:flex items-center gap-7 ml-6 text-sm">
          <span className="relative font-semibold text-foreground">
            Migration
            <span className="absolute -bottom-[18px] left-0 right-0 h-[2px] bg-primary rounded-full" />
          </span>
          <span className="text-muted-foreground hover:text-foreground cursor-pointer">Documentation</span>
          <span className="text-muted-foreground hover:text-foreground cursor-pointer">History</span>
          <span className="text-muted-foreground hover:text-foreground cursor-pointer">Settings</span>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <button className="hidden md:flex items-center gap-2 px-4 py-2 rounded-xl border border-border bg-surface text-sm">
            <span className="text-muted-foreground">19 Jun</span>
            <span className="text-muted-foreground">2024</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/80 transition">
            Deploy <Upload className="h-3.5 w-3.5" />
          </button>
          <button className="grid place-items-center h-10 w-10 rounded-xl border border-border bg-surface">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
