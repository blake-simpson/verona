import { describe, expect, it, vi } from "vitest";
import { type AgentSchedule, Scheduler } from "../../src/core/scheduler.js";
import { ScheduleError } from "../../src/util/errors.js";

function buildAgent(
  name: string,
  tasks: { id: string; schedule?: string; on_message?: boolean }[],
): AgentSchedule {
  return {
    agentName: name,
    agentDir: `/fake/agents/${name}`,
    config: {
      agent: { name, adapter: "claude-cli", default_effort: "medium" },
      soul: { file: "./SOUL.md" },
      memory: {
        index: "./memory/INDEX.md",
        self_learning: true,
        episodic_retention_days: 30,
        working_retention_days: 3,
      },
      connectors: {},
      tasks: tasks.map((t) => ({
        id: t.id,
        prompt: `./tasks/${t.id}.md`,
        ...(t.schedule !== undefined && { schedule: t.schedule }),
        ...(t.on_message !== undefined && { on_message: t.on_message }),
      })) as never,
    } as never,
  };
}

describe("Scheduler", () => {
  it("setAgents registers a job per scheduled task", () => {
    const runTask = vi.fn();
    const s = new Scheduler({ runTask });
    s.setAgents([buildAgent("a", [{ id: "t1", schedule: "0 3 * * *" }])]);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.agentName).toBe("a");
    expect(s.list()[0]?.schedule).toBe("0 3 * * *");
    expect(s.list()[0]?.nextFireAt).toBeInstanceOf(Date);
  });

  it("ignores tasks with no schedule (on_message only)", () => {
    const runTask = vi.fn();
    const s = new Scheduler({ runTask });
    s.setAgents([
      buildAgent("a", [
        { id: "scheduled", schedule: "0 3 * * *" },
        { id: "msg-only", on_message: true },
      ]),
    ]);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.taskId).toBe("scheduled");
  });

  it("setAgents replaces previous schedule", () => {
    const runTask = vi.fn();
    const s = new Scheduler({ runTask });
    s.setAgents([buildAgent("a", [{ id: "old", schedule: "0 3 * * *" }])]);
    s.setAgents([buildAgent("b", [{ id: "new", schedule: "0 4 * * *" }])]);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.agentName).toBe("b");
  });

  it("next returns the soonest task across agents", () => {
    const runTask = vi.fn();
    const s = new Scheduler({ runTask });
    s.setAgents([
      buildAgent("a", [{ id: "early", schedule: "* * * * *" }]),
      buildAgent("b", [{ id: "late", schedule: "0 0 1 1 *" }]),
    ]);
    const next = s.next();
    expect(next?.taskId).toBe("early");
  });

  it("throws ScheduleError on a bad cron expression", () => {
    const runTask = vi.fn();
    const s = new Scheduler({ runTask });
    expect(() =>
      s.setAgents([buildAgent("a", [{ id: "bad", schedule: "this is not cron" }])]),
    ).toThrow(ScheduleError);
  });

  it("isolates runTask errors via onError handler (does not throw)", async () => {
    const runTask = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    const s = new Scheduler({ runTask, onError });
    s.setAgents([buildAgent("a", [{ id: "t", schedule: "* * * * * *" /* every second */ }])]);
    s.start();
    // wait for at least one fire
    await new Promise((r) => setTimeout(r, 1500));
    await s.stop();
    expect(runTask).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
