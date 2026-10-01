"""Exercise actual arrow keys and chat navigation in a POSIX pseudo-terminal."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
tmp = ROOT / "tmp"
tmp.mkdir(exist_ok=True)


def main():
    demo = subprocess.Popen([sys.executable, "examples/demo.py"], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    child = None
    master = slave = None
    try:
        info = json.loads(demo.stdout.readline())
        request = urllib.request.Request(info["url"] + "/v1/login",
            data=json.dumps({"username": info["username"], "password": info["password"]}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            session = json.load(response)
        session["server"] = info["url"]
        with tempfile.TemporaryDirectory(dir=tmp, prefix="pty-") as directory:
            path = Path(directory)/"session.json"
            path.write_text(json.dumps(session))
            path.chmod(0o600)
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
            env = dict(os.environ, TERM="xterm-256color", GUILDPORT_CONFIG_DIR=directory, NO_COLOR="1")
            cli = os.environ.get("GUILDPORT_TEST_CLI", "cli/dist/main.js")
            child = subprocess.Popen([shutil.which("node"), cli], cwd=ROOT,
                stdin=slave, stdout=slave, stderr=slave, env=env)
            os.close(slave)
            slave = None
            output = bytearray()

            def expect(text):
                deadline = time.monotonic() + 10
                expected = text.encode()
                while expected not in output:
                    if time.monotonic() > deadline:
                        raise AssertionError(f"Missing terminal state: {text}; output={output[-1500:]!r}")
                    if select.select([master], [], [], 0.1)[0]:
                        try:
                            output.extend(os.read(master, 65536))
                        except OSError:
                            raise AssertionError(f"Terminal closed before {text}: {output[-1500:]!r}")
                del output[:output.index(expected) + len(expected)]

            def keys(value):
                os.write(master, value)

            expect("Browse servers and channels")
            keys(b"\x1b[B\r")  # Account details: prove arrow navigation changes selection.
            expect("Expires:")
            expect("Browse servers and channels")
            keys(b"\r")
            expect("Select a server")
            keys(b"\x1b[B\x1b[A\r")
            expect("select a channel")
            keys(b"\r")
            expect("/back returns")
            keys(b"PTY interactive test\r")
            expect("Sent 1000")
            keys(b"/back\r")
            expect("select a channel")
            keys(b"\x1b[B\x1b[B\r")
            expect("Select a server")
            keys(b"\x1b[B\x1b[B\r")
            expect("Browse servers and channels")
            keys(b"\x1b[B\x1b[B\x1b[B\r")
            deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
            if child.poll() is None:
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    raise AssertionError(f"Exit did not finish; output={output[-2500:]!r}")
            assert child.returncode == 0, output[-2500:]
            print("Interactive PTY smoke passed: arrow selection, account details, server/channel picker, send, back, exit.")
    finally:
        if child and child.poll() is None:
            child.kill()
            child.wait()
        if master is not None:
            os.close(master)
        if slave is not None:
            os.close(slave)
        demo.terminate()
        try:
            demo.wait(timeout=5)
        except subprocess.TimeoutExpired:
            demo.kill()
            demo.wait()


if __name__ == "__main__":
    main()
