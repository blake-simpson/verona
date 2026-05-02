/**
 * Generates the per-task `--settings` JSON file passed to `claude -p`.
 * The settings install a PreToolUse hook (memory-guard.sh) that enforces
 * the FS write boundary documented in knowledge/architecture/memory-protocol.md.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface HookSettingsRenderInput {
  /** Absolute path to memory-guard.sh on this host. */
  guardScriptPath: string;
  /** Where to write the settings file. The adapter passes this to --settings. */
  outputPath: string;
}

export async function renderHookSettings(input: HookSettingsRenderInput): Promise<void> {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [
            {
              type: "command",
              command: input.guardScriptPath,
            },
          ],
        },
      ],
    },
  };

  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, JSON.stringify(settings, null, 2), "utf8");
}
