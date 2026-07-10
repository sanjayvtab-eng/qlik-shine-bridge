import { createFileRoute } from "@tanstack/react-router";
import { Stage5Dax } from "@/components/migration/stages/Stage5Dax";

export const Route = createFileRoute("/app/dax-measures")({
  component: DaxMeasuresRoute,
});

function DaxMeasuresRoute() {
  return <Stage5Dax />;
}
