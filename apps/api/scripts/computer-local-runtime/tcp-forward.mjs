import { createConnection } from "node:net";

const port = Number(process.argv[2]);
if (port !== 5173 && port !== 6080) {
  process.stderr.write("Local bridge port is not allowed.\n");
  process.exit(64);
}

const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
socket.setNoDelay(true);
socket.once("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
