// Child process for lock tests: takes the server lock for a data folder, says "held", then waits to be killed.
import { acquireServerLock } from "../../src/server.ts";
try {
  acquireServerLock(process.argv[2]!);
  process.stdout.write("held\n");
  setInterval(() => {}, 1000);
} catch (error) {
  process.stdout.write(`refused ${(error as { code?: string }).code}\n`);
  process.exit(0);
}
