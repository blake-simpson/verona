/**
 * `verona` CLI entry point. Compiled to dist/cli/index.js; bin/verona shims
 * to it.
 */

import path from "node:path";
import { Command } from "commander";
import { runAgentsAdd, runAgentsInit, runAgentsList, runAgentsRemove } from "./commands/agents.js";
import { runConnectorsAdd, runConnectorsTest } from "./commands/connectors.js";
import { runCosts } from "./commands/costs.js";
import { runDaemonCmd } from "./commands/daemon.js";
import { formatDoctorReport, runDoctor } from "./commands/doctor.js";
import { describeInit, runInit } from "./commands/init.js";
import { runInvocations } from "./commands/invocations.js";
import { formatLogList, listLogs, readLatestLog } from "./commands/logs.js";
import { runReload } from "./commands/reload.js";
import { runScheduleList, runScheduleNext, runScheduleRun } from "./commands/schedule.js";
import {
  formatInstallResult,
  runServiceInstall,
  runServiceLogs,
  runServiceRestart,
  runServiceStatus,
  runServiceUninstall,
} from "./commands/service.js";

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = new Command();
  program
    .name("verona")
    .description("Self-hosted CLI framework for scheduled, self-learning AI agents.")
    .option("--state-dir <path>", "override the runtime state dir (default: ~/.verona/state)")
    .showHelpAfterError();

  program
    .command("init")
    .description("scaffold the runtime state dir + initialize its git repo")
    .action(async () => {
      const result = await runInit({ stateDir: program.opts().stateDir });
      process.stdout.write(`${describeInit(result)}\n`);
    });

  program
    .command("doctor")
    .description("verify host readiness (claude binary, state dir, perms, git)")
    .option("--no-check-claude", "skip the claude --version probe")
    .action(async (cmdOpts: { checkClaude: boolean }) => {
      const checks = await runDoctor({
        stateDir: program.opts().stateDir,
        checkClaude: cmdOpts.checkClaude,
      });
      process.stdout.write(`${formatDoctorReport(checks)}\n`);
      const ok = checks.every((c) => c.ok);
      process.exitCode = ok ? 0 : 1;
    });

  const agents = program
    .command("agents")
    .description("manage agent registrations in the state dir");

  agents
    .command("init <name>")
    .description(
      "scaffold a new agent in your user-agents dir from a bundled template (does NOT register; run `agents add` after reviewing)",
    )
    .requiredOption(
      "-t, --template <template>",
      "template to copy from (e.g. hello-world, researcher)",
    )
    .option("--agents-dir <path>", "override the user-agents dir (default: ~/.verona/agents)")
    .action(async (name: string, cmdOpts: { template: string; agentsDir?: string }) => {
      const result = await runAgentsInit({
        name,
        template: cmdOpts.template,
        ...(cmdOpts.agentsDir !== undefined && { agentsDir: cmdOpts.agentsDir }),
      });
      process.stdout.write(
        [
          `scaffolded ${result.agentName} from template "${path.basename(result.templateDir)}"`,
          `  target:   ${result.targetDir}`,
          `  template: ${result.templateDir}`,
          "",
          "Next:",
          `  $EDITOR ${result.targetDir}    # review SOUL.md, agent.toml, tasks/`,
          `  verona agents add ${result.targetDir}`,
          "",
        ].join("\n"),
      );
    });

  agents
    .command("add <source-dir>")
    .description("register a new agent (or refresh protected files of an existing one)")
    .action(async (sourceDir: string) => {
      const result = await runAgentsAdd({
        sourceDir,
        stateDir: program.opts().stateDir,
      });
      const verb = result.fresh ? "registered" : "updated";
      const commitNote = result.commit ? ` (commit ${result.commit.slice(0, 8)})` : " (no changes)";
      process.stdout.write(`${verb} ${result.agentName} → ${result.destination}${commitNote}\n`);
    });

  agents
    .command("list")
    .description("list registered agents")
    .action(async () => {
      const names = await runAgentsList({ stateDir: program.opts().stateDir });
      if (names.length === 0) {
        process.stdout.write("(no agents registered)\n");
        return;
      }
      for (const name of names) process.stdout.write(`${name}\n`);
    });

  agents
    .command("remove <name>")
    .description(
      "remove an agent from the state tree (DELETES its memory; run `verona reload` after to drop its schedule from a running daemon)",
    )
    .action(async (name: string) => {
      const result = await runAgentsRemove({
        name,
        stateDir: program.opts().stateDir,
      });
      const commitNote = result.commit
        ? ` (commit ${result.commit.slice(0, 8)})`
        : " (no commit — was already absent from git)";
      process.stdout.write(`removed ${result.agentName} → ${result.removedDir}${commitNote}\n`);
      process.stdout.write(
        "Note: a running daemon won't drop the schedule until you run `verona reload` or restart it.\n",
      );
    });

  program
    .command("daemon")
    .description("run the long-lived daemon (scheduler + future connectors)")
    .action(async () => {
      await runDaemonCmd({ stateDir: program.opts().stateDir });
    });

  program
    .command("reload")
    .description(
      "signal a running daemon to re-read agent configs (SIGHUP). connectors / Slack tokens still require a full restart.",
    )
    .action(async () => {
      const result = await runReload({ stateDir: program.opts().stateDir });
      process.stdout.write(`signaled daemon (pid ${result.pid}) to reload\n`);
    });

  const schedule = program.command("schedule").description("inspect and trigger task schedules");

  schedule
    .command("list")
    .description("aggregated view of every scheduled task across agents")
    .action(async () => {
      const out = await runScheduleList({ stateDir: program.opts().stateDir });
      process.stdout.write(`${out}\n`);
    });

  schedule
    .command("next")
    .description("show the next task to fire")
    .action(async () => {
      const out = await runScheduleNext({ stateDir: program.opts().stateDir });
      process.stdout.write(`${out}\n`);
    });

  schedule
    .command("run <task-spec>")
    .description("trigger a task immediately, e.g. `verona schedule run hello-world:greet`")
    .option("--message <text>", "user-message overlay for the task prompt")
    .action(async (taskSpec: string, cmdOpts: { message?: string }) => {
      await runScheduleRun({
        taskSpec,
        stateDir: program.opts().stateDir,
        ...(cmdOpts.message !== undefined && { userMessage: cmdOpts.message }),
      });
      process.stdout.write(`ran ${taskSpec}\n`);
    });

  const connectors = program
    .command("connectors")
    .description("manage connector tokens and run smoke tests");

  connectors
    .command("add <id>")
    .description("interactively capture connector tokens (currently: slack)")
    .action(async (connectorId: string) => {
      const written = await runConnectorsAdd({
        connectorId,
        stateDir: program.opts().stateDir,
      });
      process.stdout.write(`tokens saved (chmod 0600):\n  ${written.join("\n  ")}\n`);
    });

  connectors
    .command("test <id>")
    .description("send a smoke-test message via the named connector")
    .option("--destination <chan>", "destination (slack: #channel or channel id)")
    .option("--text <text>", "override the test message body")
    .action(async (connectorId: string, cmdOpts: { destination?: string; text?: string }) => {
      const out = await runConnectorsTest({
        connectorId,
        stateDir: program.opts().stateDir,
        ...(cmdOpts.destination !== undefined && { destination: cmdOpts.destination }),
        ...(cmdOpts.text !== undefined && { text: cmdOpts.text }),
      });
      process.stdout.write(`${out}\n`);
    });

  program
    .command("invocations")
    .description("query the audit log of every adapter + connector call")
    .option("--agent <name>", "filter by agent")
    .option("--task <id>", "filter by task")
    .option("--connector <id>", "filter by connector")
    .option("--since <duration>", "only entries newer than this (e.g. 30m, 1h, 7d)")
    .option("--limit <n>", "max records to return (default 50)", (v) => Number(v))
    .option("--ok", "only successful records")
    .option("--failed", "only failed records (sets ok=false)")
    .option("--json", "stream raw NDJSON instead of the formatted table")
    .action(
      async (cmdOpts: {
        agent?: string;
        task?: string;
        connector?: string;
        since?: string;
        limit?: number;
        ok?: boolean;
        failed?: boolean;
        json?: boolean;
      }) => {
        const out = await runInvocations({
          stateDir: program.opts().stateDir,
          ...(cmdOpts.agent !== undefined && { agent: cmdOpts.agent }),
          ...(cmdOpts.task !== undefined && { task: cmdOpts.task }),
          ...(cmdOpts.connector !== undefined && { connector: cmdOpts.connector }),
          ...(cmdOpts.since !== undefined && { since: cmdOpts.since }),
          ...(cmdOpts.limit !== undefined && { limit: cmdOpts.limit }),
          ...(cmdOpts.ok && { ok: true }),
          ...(cmdOpts.failed && { ok: false }),
          ...(cmdOpts.json && { json: true }),
        });
        process.stdout.write(`${out}\n`);
      },
    );

  program
    .command("costs")
    .description("rollup of token usage and metered $ across the audit log")
    .action(async () => {
      const out = await runCosts({ stateDir: program.opts().stateDir });
      process.stdout.write(`${out}\n`);
    });

  program
    .command("logs <agent>")
    .description("show this agent's per-run episodic logs (latest first)")
    .option("--task <id>", "filter to a specific task")
    .option("--latest", "print the body of the latest run instead of the index")
    .option("--limit <n>", "limit the index to N entries", (v) => Number(v))
    .action(
      async (agentName: string, cmdOpts: { task?: string; latest?: boolean; limit?: number }) => {
        const baseOpts: {
          agentName: string;
          stateDir?: string;
          taskId?: string;
          limit?: number;
        } = { agentName };
        if (program.opts().stateDir !== undefined) baseOpts.stateDir = program.opts().stateDir;
        if (cmdOpts.task !== undefined) baseOpts.taskId = cmdOpts.task;
        if (cmdOpts.limit !== undefined) baseOpts.limit = cmdOpts.limit;

        if (cmdOpts.latest) {
          const body = await readLatestLog(baseOpts);
          process.stdout.write(body || "(no logs)\n");
        } else {
          const entries = await listLogs(baseOpts);
          process.stdout.write(`${formatLogList(entries)}\n`);
        }
      },
    );

  const service = program
    .command("service")
    .description("register the daemon with the host service manager (systemd / launchd)");

  service
    .command("install")
    .description("write the unit file and enable+start the daemon")
    .option("--node-bin <path>", "absolute path to the node binary (default: process.execPath)")
    .option("--dry-run", "render the unit file but skip loader commands", false)
    .action(async (cmdOpts: { nodeBin?: string; dryRun: boolean }) => {
      const result = await runServiceInstall({
        stateDir: program.opts().stateDir,
        ...(cmdOpts.nodeBin !== undefined && { nodeBin: cmdOpts.nodeBin }),
        dryRun: cmdOpts.dryRun,
      });
      process.stdout.write(`${formatInstallResult(result)}\n`);
    });

  service
    .command("uninstall")
    .description("stop, disable, and remove the daemon unit file")
    .action(async () => {
      const result = await runServiceUninstall({ stateDir: program.opts().stateDir });
      process.stdout.write(`uninstalled (${result.platform})\n  unit: ${result.unitPath}\n`);
      for (const block of result.loaderOutput) process.stdout.write(`\n${block}\n`);
    });

  service
    .command("status")
    .description("show the service manager's view of the daemon")
    .action(async () => {
      const out = await runServiceStatus({ stateDir: program.opts().stateDir });
      process.stdout.write(`${out}\n`);
    });

  service
    .command("restart")
    .description("restart the running daemon (systemctl restart / launchctl kickstart)")
    .action(async () => {
      const out = await runServiceRestart({ stateDir: program.opts().stateDir });
      process.stdout.write(`${out}\n`);
    });

  service
    .command("logs")
    .description("stream daemon logs (journalctl on Linux, tail on macOS)")
    .option("-n, --lines <count>", "number of historical lines to show before following", "100")
    .option("--no-follow", "dump and exit instead of following")
    .action(async (cmdOpts: { lines: string; follow: boolean }) => {
      const lines = Number.parseInt(cmdOpts.lines, 10);
      if (!Number.isFinite(lines) || lines < 0) {
        throw new Error(`--lines must be a non-negative integer (got ${cmdOpts.lines})`);
      }
      await runServiceLogs({
        stateDir: program.opts().stateDir,
        lines,
        follow: cmdOpts.follow,
      });
    });

  await program.parseAsync(argv);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

const isMain =
  typeof import.meta.url === "string" &&
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")));

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`verona: ${msg}\n`);
    if (err instanceof Error && err.stack && process.env.VERONA_DEBUG) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  });
}
