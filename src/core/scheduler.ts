/**
 * Scheduler — croner-backed, in-process. Aggregates per-agent task schedules
 * (declared in each agent.toml) and fires task runs on time.
 *
 * The scheduler does NOT own the dispatcher; instead it calls back into a
 * `runTask` callback supplied by the daemon. Keeps the cron concern isolated.
 */

import { Cron } from "croner";
import type { AgentConfig } from "../config/schema.js";
import { ScheduleError } from "../util/errors.js";

export interface AgentSchedule {
  agentName: string;
  agentDir: string;
  config: AgentConfig;
}

export interface JobInfo {
  agentName: string;
  taskId: string;
  schedule: string;
  nextFireAt: Date | null;
}

export interface SchedulerInit {
  /**
   * Invoked when a scheduled task fires. Errors are logged inside the
   * scheduler and don't propagate (so one bad task doesn't kill the daemon).
   */
  runTask: (input: {
    agentName: string;
    taskId: string;
    schedule: string;
  }) => Promise<void>;
  /** Called to log errors thrown by runTask. Defaults to console.error. */
  onError?: (err: unknown, ctx: { agentName: string; taskId: string }) => void;
}

interface RegisteredJob {
  agentName: string;
  taskId: string;
  schedule: string;
  cron: Cron;
}

export class Scheduler {
  private readonly init: SchedulerInit;
  private jobs: RegisteredJob[] = [];
  private started = false;

  constructor(init: SchedulerInit) {
    this.init = init;
  }

  /**
   * Replace the current schedule with the union of all tasks across the
   * provided agents. Idempotent — call again after agent config changes.
   */
  setAgents(agents: readonly AgentSchedule[]): void {
    this.cancelAll();
    for (const a of agents) {
      for (const task of a.config.tasks) {
        if (!task.schedule) continue;
        let cron: Cron;
        try {
          cron = new Cron(
            task.schedule,
            { paused: !this.started, name: `${a.agentName}:${task.id}` },
            () => {
              void this.fire(a.agentName, task.id, task.schedule!);
            },
          );
        } catch (err) {
          throw new ScheduleError(
            `invalid schedule "${task.schedule}" for ${a.agentName}:${task.id}`,
            { cause: err },
          );
        }
        this.jobs.push({
          agentName: a.agentName,
          taskId: task.id,
          schedule: task.schedule,
          cron,
        });
      }
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const j of this.jobs) j.cron.resume();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.cancelAll();
  }

  list(): JobInfo[] {
    return this.jobs.map((j) => ({
      agentName: j.agentName,
      taskId: j.taskId,
      schedule: j.schedule,
      nextFireAt: j.cron.nextRun(),
    }));
  }

  next(): JobInfo | null {
    const upcoming = this.list()
      .filter((j) => j.nextFireAt !== null)
      .sort((a, b) => a.nextFireAt!.getTime() - b.nextFireAt!.getTime());
    return upcoming[0] ?? null;
  }

  private cancelAll(): void {
    for (const j of this.jobs) j.cron.stop();
    this.jobs = [];
  }

  private async fire(agentName: string, taskId: string, schedule: string): Promise<void> {
    try {
      await this.init.runTask({ agentName, taskId, schedule });
    } catch (err) {
      const handler = this.init.onError ?? defaultErrorHandler;
      handler(err, { agentName, taskId });
    }
  }
}

function defaultErrorHandler(err: unknown, ctx: { agentName: string; taskId: string }): void {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[scheduler] ${ctx.agentName}:${ctx.taskId} failed: ${msg}\n`);
}
