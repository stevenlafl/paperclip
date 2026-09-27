import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Comments queued for the requesting agent's next turn on the issue its current
 * run is executing. A queued comment is delivered by that next turn; showing it
 * to the current turn through the API lets the agent answer it early, and the
 * queued turn then runs anyway. The same agent reading another issue, other
 * agents, and board users still see every comment.
 */
export async function commentIdsQueuedForActingRun(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; runId: string | null | undefined },
): Promise<Set<string>> {
  if (!input.runId) return new Set();
  const [run] = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
  ));
  const runIssueId = record(run?.context).issueId ?? record(run?.context).taskId;
  if (runIssueId !== input.issueId) return new Set();
  const deferred = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
  ));
  const ids = new Set<string>();
  for (const { payload } of deferred) {
    for (const id of queuedCommentIdsFromWakePayload(payload)) ids.add(id);
    const context = record(record(payload)._paperclipWakeContext);
    for (const id of [record(payload).commentId, context.commentId, context.wakeCommentId]) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return ids;
}
