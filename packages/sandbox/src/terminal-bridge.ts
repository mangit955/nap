/** Python's standard-library PTY keeps the Node supervisor bundle independent of native addons. */
export const TERMINAL_BRIDGE = String.raw`
import errno, fcntl, json, os, select, signal, struct, sys, termios

pid = None
master = None

def forward(signum, frame):
    if pid is not None:
        try:
            os.killpg(pid, signum)
        except ProcessLookupError:
            pass

def size(columns, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

try:
    config = json.loads(sys.argv[1])
    master, slave = os.openpty()
    size(config["terminal"]["columns"], config["terminal"]["rows"])
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, forward)
    pid = os.fork()
    if pid == 0:
        os.close(master)
        master = None
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(signum, signal.SIG_DFL)
        os.execve(config["executable"], [config["executable"]] + config["args"], os.environ)
    os.close(slave)
    os.set_blocking(master, False)
    incoming = bytearray()
    pending = bytearray()
    while True:
        readable, writable, _ = select.select([0, master], [master] if pending else [], [], 0.1)
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            view = memoryview(data)
            while view:
                view = view[os.write(1, view):]
        if master in writable:
            try:
                written = os.write(master, pending)
                del pending[:written]
            except BlockingIOError:
                pass
        if 0 in readable:
            data = os.read(0, 65536)
            if not data:
                forward(signal.SIGHUP, None)
                break
            incoming.extend(data)
            if len(incoming) > 524288:
                raise ValueError("terminal frame limit")
            while b"\n" in incoming:
                line, _, rest = incoming.partition(b"\n")
                incoming = bytearray(rest)
                command = json.loads(line)
                if command["type"] == "input":
                    pending.extend(command["data"].encode("utf-8"))
                    if len(pending) > 2097152:
                        raise ValueError("terminal input limit")
                elif command["type"] == "resize":
                    size(command["columns"], command["rows"])
                else:
                    raise ValueError("terminal command")
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    sys.exit(code if code >= 0 else 128 - code)
except SystemExit:
    raise
except BaseException:
    os.write(2, b"Terminal bootstrap failed.\n")
    sys.exit(126)
finally:
    if pid is not None and pid > 0:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if master is not None:
        os.close(master)
`;
