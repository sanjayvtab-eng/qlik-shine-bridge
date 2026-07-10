import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Stage4PowerQuery } from "@/components/migration/stages/Stage4PowerQuery";

export const Route = createFileRoute("/app/power-query")({
  component: PowerQueryRoute,
});

function PowerQueryRoute() {
  const navigate = useNavigate();
  return <Stage4PowerQuery onNext={() => navigate({ to: "/app/semantic-model" })} />;
}
