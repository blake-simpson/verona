/**
 * UserSync — periodic git-pull of ~/.verona/user/. When the daemon detects a
 * new HEAD, it fires `daemon.reload()` so the next scheduled run picks up the
 * fresh agent / connector code.
 *
 * Disabled by default. Enable in state/verona.toml:
 *
 *   [user_sync]
 *   enabled = true
 *   interval = "*\/5 * * * *"   # croner-compatible
 *   reload_on_change = true
 *
 * Polling-only at v1. A webhook receiver may follow if anyone needs sub-poll
 * latency. See knowledge/architecture/connector-contract.md (v2 sync notes).
 */

import { Cron } from "croner";
import { runUserPull } from "../cli/commands/user.js";

export interface UserSyncInit {
  enabled: boolean;
  interval: string;
  reloadOnChange: boolean;
  stateDir: string;
  /**
   * Called after a pull that changes HEAD, when reloadOnChange is true. The
   * daemon binds this to its own `reload()` so we don't go through SIGHUP /
   * pidfile. Awaited — exceptions surface to the cron tick.
   */
  onChange?: () => Promise<void>;
}

export class UserSync {
  private cron: Cron | undefined;
  private readonly init: UserSyncInit;
  private running = false;

  constructor(init: UserSyncInit) {
    this.init = init;
  }

  start(): void {
    if (!this.init.enabled) return;
    if (this.cron) return;
    this.cron = new Cron(this.init.interval, { protect: true }, async () => {
      await this.tick();
    });
  }

  stop(): void {
    if (this.cron) {
      this.cron.stop();
      this.cron = undefined;
    }
  }

  /**
   * Run one pull tick. Exposed for tests and `verona schedule run user-sync`.
   * Swallows pull errors (logs to stderr) so a transient network blip doesn't
   * crash the daemon.
   */
  async tick(): Promise<void> {
    if (this.running) return; // overlap guard (also enforced by cron `protect`)
    this.running = true;
    try {
      const result = await runUserPull({
        stateDir: this.init.stateDir,
        noReload: true, // we'll fire onChange ourselves; SIGHUP-to-self is gross
      });
      if (result.changed && this.init.reloadOnChange && this.init.onChange) {
        try {
          await this.init.onChange();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`user-sync: reload after pull failed — ${msg}\n`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`user-sync: pull failed — ${msg}\n`);
    } finally {
      this.running = false;
    }
  }
}
