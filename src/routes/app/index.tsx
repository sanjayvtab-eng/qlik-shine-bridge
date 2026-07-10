import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Stage3AiAnalysis } from "@/components/migration/stages/Stage3AiAnalysis";

export const Route = createFileRoute("/app/")({
  component: AppIndexRoute,
});

function AppIndexRoute() {
  const navigate = useNavigate();
  return <Stage3AiAnalysis onNext={() => navigate({ to: "/app/analysis" })} />;
}
