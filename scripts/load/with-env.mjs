/**
 * Run a command with an env file loaded, without `node --env-file`.
 *
 *   node scripts/load/with-env.mjs .env.load node_modules/next/dist/bin/next build
 *
 * `node --env-file=… next build` fails: Next starts worker processes that inherit the parent's
 * `--env-file` flag through NODE_OPTIONS, and Node refuses it there ("--env-file= is not allowed
 * in NODE_OPTIONS"). Loading the file into the environment here and then spawning the command
 * with nothing special on its command line gives the same result without the flag.
 *
 * Variables already set in the environment win, as with --env-file, so a shell can still override.
 */
import { spawn } from "node:child_process";

const [file, script, ...args] = process.argv.slice(2);
if (!file || !script) {
  console.error("usage: with-env.mjs <env-file> <node script> [args...]");
  process.exit(2);
}
process.loadEnvFile(file);

const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
