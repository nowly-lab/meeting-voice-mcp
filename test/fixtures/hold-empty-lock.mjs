// Child: an owner paused right after taking the lock, before writing its metadata (empty lock file).
import { constants, openSync } from "node:fs";
import { join } from "node:path";
const O_EXLOCK = 0x20;
openSync(join(process.argv[2], "server.lock"), constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);
process.stdout.write("held\n");
setInterval(() => {}, 1000);
