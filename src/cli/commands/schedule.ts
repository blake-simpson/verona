import { Daemon } from "../../core/daemon.js";
import { resolveStateDir } from "../../state/paths.js";

export interface ScheduleOptions {
  stateDir?: string;
}

export async function runScheduleList(opts: ScheduleOptions = {}): Promise<string> {
  const daemon = new Daemon({ stateDir: resolveStateDir(opts.stateDir) });
  await daemon.bootstrap();
  const jobs = daemon.scheduler_().list();
  await daemon.stop();
  if (jobs.length === 0) return "(no scheduled tasks)";
  const rows = jobs.map((j) => {
    const next = j.nextFireAt ? j.nextFireAt.toISOString() : "(unscheduled)";
    return `${j.agentName}:${j.taskId}  schedule=${j.schedule}  next=${next}`;
  });
  return rows.join("\n");
}

export async function runScheduleNext(opts: ScheduleOptions = {}): Promise<string> {
  const daemon = new Daemon({ stateDir: resolveStateDir(opts.stateDir) });
  await daemon.bootstrap();
  const next = daemon.scheduler_().next();
  await daemon.stop();
  if (!next || !next.nextFireAt) return "(no scheduled tasks)";
  return `${next.agentName}:${next.taskId}  ${next.schedule}  ${next.nextFireAt.toISOString()}`;
}

export interface ScheduleRunOptions extends ScheduleOptions {
  /** Spec like "agent-name:task-id". */
  taskSpec: string;
  userMessage?: string;
}

export async function runScheduleRun(opts: ScheduleRunOptions): Promise<void> {
  const [agentName, taskId] = opts.taskSpec.split(":");
  if (!agentName || !taskId) {
    throw new Error(`invalid task spec "${opts.taskSpec}" — expected "<agent>:<task>"`);
  }
  const daemon = new Daemon({ stateDir: resolveStateDir(opts.stateDir) });
  await daemon.bootstrap();
  try {
    await daemon.runTask({
      agentName,
      taskId,
      trigger: { kind: "manual" },
      ...(opts.userMessage !== undefined && { userMessage: opts.userMessage }),
    });
  } finally {
    await daemon.stop();
  }
}
