import { Daemon } from "../../core/daemon.js";
import { resolveStateDir } from "../../state/paths.js";

export interface DaemonOptions {
  stateDir?: string;
}

export async function runDaemonCmd(opts: DaemonOptions = {}): Promise<void> {
  const stateDir = resolveStateDir(opts.stateDir);
  const daemon = new Daemon({ stateDir });
  await daemon.bootstrap();
  daemon.start();
  await daemon.run();
}
