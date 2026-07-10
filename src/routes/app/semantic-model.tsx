import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Stage6Model } from "@/components/migration/stages/Stage6Model";

export const Route = createFileRoute("/app/semantic-model")({
  component: SemanticModelRoute,
});

function SemanticModelRoute() {
  const navigate = useNavigate();
  return <Stage6Model onNext={() => navigate({ to: "/app/dax-measures" })} />;
}
