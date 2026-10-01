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
    demo = subprocess.Popen([sys.executable, "examples/demo.py", "--seed"], cwd=ROOT,
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
            slave_name = os.ttyname(slave)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
            env = dict(os.environ, TERM="xterm-256color", GUILDPORT_CONFIG_DIR=directory, NO_COLOR="1")
            cli = os.environ.get("GUILDPORT_TEST_CLI", "cli/dist/main.js")
            child = subprocess.Popen([shutil.which("node"), cli], cwd=ROOT,
                stdin=slave, stdout=slave, stderr=slave, env=env)
            os.close(slave)
            slave = None
            output = bytearray()
            transcript = bytearray()

            def expect(text):
                deadline = time.monotonic() + 10
                expected = text.encode()
                while expected not in output:
                    if time.monotonic() > deadline:
                        raise AssertionError(f"Missing terminal state: {text}; output={output[-1500:]!r}")
                    if select.select([master], [], [], 0.1)[0]:
                        try:
                            chunk = os.read(master, 65536)
                            output.extend(chunk)
                            transcript.extend(chunk)
                        except OSError:
                            raise AssertionError(f"Terminal closed before {text}: {output[-1500:]!r}")
                del output[:output.index(expected) + len(expected)]

            def keys(value):
                os.write(master, value)

            def api(path, data=None):
                request=urllib.request.Request(info["url"]+path,
                    data=json.dumps(data).encode() if data is not None else None,
                    headers={"Authorization":"Bearer "+session["token"],"Content-Type":"application/json"})
                with urllib.request.urlopen(request,timeout=5) as response:
                    return json.load(response)

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
            expect("Connected")
            # Bracketed multiline paste must stay in the composer until Enter.
            keys("\x1b[200~PTY 中文 🌿\nsecond line\x1b[201~".encode())
            expect("multiline draft")
            assert api('/v1/channels/200/messages?limit=1')['messages'][0]['id'] == '1119'
            keys(b"\r")
            expect("Sent")
            assert api('/v1/channels/200/messages?limit=1')['messages'][0]['content'] == 'PTY 中文 🌿\nsecond line'
            # Keep a draft and scroll position while another message arrives.
            keys(b"draft stays")
            expect("draft stays")
            keys(b"\x1b[5~")
            expect("Esc back")
            import uuid
            api('/v1/channels/200/messages',{'content':'Live arrival while reading','request_id':str(uuid.uuid4())})
            expect("1 new")
            expect("draft stays")
            keys(b"\x1b[F")
            expect("Live arrival while reading")
            expect("draft stays")
            # Exercise resizing without losing input and load a previous history page.
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 55, 0, 0))
            child.send_signal(signal.SIGWINCH)
            expect("draft stays")
            keys(b"\x1b[H\x1b[5~")
            expect("Older messages loaded")
            keys(b"\x1b[F")
            expect("draft stays")
            (tmp/'chat-screen.ansi').write_bytes(transcript)
            # Esc exits chat and each nested picker; no typed /back is required.
            keys(b"\x1b")
            expect("\x1b[?1049l")
            expect("select a channel")
            keys(b"\x1b")
            expect("Select a server")
            keys(b"\x1b")
            expect("Browse servers and channels")
            keys(b"\x1b")
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
            # External termination and revoked access must also restore the terminal.
            for revoke in (False,True):
                output.clear()
                slave=os.open(slave_name,os.O_RDWR)
                child=subprocess.Popen([shutil.which('node'),cli,'chat','200'],cwd=ROOT,
                    stdin=slave,stdout=slave,stderr=slave,env=env)
                os.close(slave); slave=None
                expect('Connected')
                if revoke:
                    api('/v1/logout-all',{})
                    # Trigger an immediate per-event permission/session check.
                    fresh=urllib.request.Request(info['url']+'/v1/login',data=json.dumps({
                        'username':info['username'],'password':info['password']}).encode(),headers={'Content-Type':'application/json'})
                    with urllib.request.urlopen(fresh,timeout=5) as response:
                        session['token']=json.load(response)['token']
                    api('/v1/channels/200/messages',{'content':'Revocation probe','request_id':str(uuid.uuid4())})
                else:
                    child.send_signal(signal.SIGTERM)
                expect('\x1b[?1049l')
                child.wait(timeout=3)
                assert child.returncode == (1 if revoke else 143), child.returncode
                assert termios.tcgetattr(master)[3] & termios.ICANON
            print("Interactive PTY smoke passed: menus, multiline paste, live messages, draft preservation, scroll, history pagination, resize, Esc navigation, revocation, signal exit, terminal restore.")
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
