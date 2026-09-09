import { toolSpecs } from "@/agent/tools";
import { workspaceRoot } from "@/agent/workspace";

export const dynamic = "force-dynamic";

/** List every real capability registered in Kaira's tool registry. */
export async function GET() {
  return Response.json({
    ok: true,
    tools: toolSpecs(),
    workspace: { root: workspaceRoot() },
  });
}
