"""Exercise TLS on the shipped runner, with a loopback peer and an isolated app ID."""
import json
import os
from pathlib import Path
import plistlib
import socket
import subprocess
import sys
import tempfile
import time


def check(package, work):
    info = plistlib.loads((package / "Contents/Info.plist").read_bytes())
    executable = package / "Contents/MacOS" / info["CFBundleExecutable"]
    resources = work / "nsh"
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        server.settimeout(30)
        port = server.getsockname()[1]
        entry = work / "App.tsx"
        entry.write_text(f"""
import {{ mount, Text }} from "nsh";
mount(() => <Text>WebSocket check</Text>);
const ws = new WebSocket("wss://127.0.0.1:{port}/");
ws.onclose = () => console.log("NOOP_TLS_CLOSE_OK");
""")
        (work / "nsh.json").write_text(json.dumps({
            "name": "WebSocket check",
            "id": "dev.noop.websocket-check",
            "capabilities": {"network": {"hosts": ["127.0.0.1"]}},
        }))
        subprocess.run(["nsh", "build", str(entry), "-o", str(resources)], cwd=work, check=True)
        log = work / "runner.log"
        with log.open("wb") as output:
            runner = subprocess.Popen([executable],
                                      stdout=output, stderr=subprocess.STDOUT,
                                      env={**os.environ, "RUST_LOG": "info", "NSH_APP_DIR": str(resources)})
            try:
                with server.accept()[0] as peer:
                    peer.settimeout(15)
                    if peer.recv(1) != b"\x16":
                        raise RuntimeError("The packaged runner did not start a TLS handshake")
                # Closing the peer mid-handshake must return control to JavaScript.
                for _ in range(150):
                    if "NOOP_TLS_CLOSE_OK" in log.read_text(errors="replace"):
                        return
                    time.sleep(0.1)
                raise RuntimeError("The WebSocket close event never reached JavaScript")
            finally:
                runner.kill()
                runner.wait()
                print(log.read_text(errors="replace"))


with tempfile.TemporaryDirectory() as temp:
    check(Path(sys.argv[1]), Path(temp))
