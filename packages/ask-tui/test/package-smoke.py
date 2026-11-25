#!/usr/bin/env python3
"""Exercise the installed ask-tui launcher/native UI in a real PTY, offline.

Run after installing the tarball: python3 packages/ask-tui/test/package-smoke.py [launcher]
The optional launcher path supports checking a local build with the same harness.
"""
import errno
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import selectors
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time


def main():
    executable = sys.argv[1] if len(sys.argv) > 1 else shutil.which("ask-tui")
    if not executable:
        raise RuntimeError("Install the tarball first: ask-tui must be on PATH")
    executable = str(Path(executable).absolute())
    requests = []

    class Provider(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(request)
            if len(requests) <= 2:
                response = b'{"error":{"message":"Retry this transient failure"}}'
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.send_header("retry-after-ms", "1")
                self.end_headers()
                self.wfile.write(response)
                return
            response = json.dumps({
                "id": "package-smoke", "object": "chat.completion", "created": 0, "model": "smoke",
                "choices": [{"index": 0, "finish_reason": "stop", "message": {
                    "role": "assistant", "content": (
                        '<update path="sample.ts">\n<<<<<<< SEARCH\nconst x = 1;\n'
                        '=======\nconst x = 2;\n>>>>>>> REPLACE\n</update>'
                    ),
                }}],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            pass

    with tempfile.TemporaryDirectory(prefix="ask-installed-tui-") as directory:
        cwd = Path(directory)
        target = cwd / "sample.ts"
        target.write_text("const x = 1;\n")
        (cwd / "bunfig.toml").write_text('preload = ["./hook.ts"]\n')
        (cwd / "hook.ts").write_text('await Bun.write("preload-executed", "unsafe");\n')
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("ASK_", "OPENAI_", "BUN_")) and key not in ("NODE_OPTIONS", "NO_COLOR")}
        env["TERM"] = "xterm-256color"
        # Never read the developer's own config. The repository .env must be ignored;
        # the user's ask.json (owner-only) is what supplies settings.
        config = Path(directory) / "config-home"
        (config / "ask").mkdir(parents=True)
        (config / "ask" / "ask.json").write_text('{ "system": "config-system-marker" }')
        (config / "ask" / "ask.json").chmod(0o600)
        # Simulate a theme saved in another project, whose palette is unavailable
        # here. Startup must recover without overwriting the saved preference.
        saved = config / "ask" / "tui.json"
        saved.write_text('{ "theme": "project-only" }')
        saved.chmod(0o600)
        env["ASK_STATE_DIR"] = str(Path(directory) / "state")
        env["XDG_CONFIG_HOME"] = str(config)
        (cwd / ".env").write_text("ASK_SYSTEM=repository-system-marker\nOPENAI_API_KEY=repository-key\n")
        output = bytearray()
        process = None
        selector = selectors.DefaultSelector()
        selector.register(master, selectors.EVENT_READ)

        def wait_for(predicate, description):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if predicate():
                    return
                for _key, _events in selector.select(0.05):
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                if process.poll() is not None and not predicate():
                    break
            raise AssertionError(f"Timed out waiting for {description}; exit={process.poll()}; output={bytes(output[-12000:])!r}")

        try:
            process = subprocess.Popen([
                executable, "--model", "smoke", "--no-mouse",
                "--base-url", f"http://127.0.0.1:{server.server_port}/v1",
            ], cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            slave = None
            wait_for(lambda: b"Ready" in output, "native renderer startup")
            wait_for(lambda: b"using ask" in output, "unavailable saved theme fallback notice")
            assert json.loads(saved.read_text())["theme"] == "project-only"
            # Trailing question text keeps the @ picker closed when Enter submits.
            os.write(master, b"Update @sample.ts please\r")
            wait_for(lambda: b"/review to inspect" in output, "completion and proposal summary")
            assert target.read_text() == "const x = 1;\n", "proposal wrote without approval"
            os.write(master, b"/review\r")
            # The proposal preview already contains the diff. Wait for the
            # review-specific confirmation before sending the next command.
            wait_for(lambda: b"Review the proposed diffs above." in output, "diff review")
            assert target.read_text() == "const x = 1;\n", "review wrote without approval"
            os.write(master, b"/apply\r")
            wait_for(lambda: target.read_text() == "const x = 2;\n", "approved write")
            assert len(requests) == 3, "expected two transport retries, without local approval making another request"
            assert requests[0] == requests[1] == requests[2], "retry changed the request body"
            assert "const x = 1;" in requests[0]["messages"][-1]["content"]
            system = requests[0]["messages"][0]["content"]
            assert "config-system-marker" in system, "config file was not applied"
            assert "repository-system-marker" not in system, "repository .env was read"
            assert not (cwd / "preload-executed").exists(), "repository preload executed"
            # Wait for the local write to finish updating the UI before quitting.
            wait_for(lambda: b"Applied updates" in output, "write confirmation")
            # Choosing a theme saves it, writing only the user's global tui.json.
            os.write(master, b"/theme nord")
            wait_for(lambda: b"nord" in output, "theme picker")
            os.write(master, b"\r")
            wait_for(lambda: saved.exists() and json.loads(saved.read_text()).get("theme") == "nord", "saved theme")
            assert (saved.stat().st_mode & 0o777) == 0o600, oct(saved.stat().st_mode)
            os.write(master, b"/quit\r")
            wait_for(lambda: process.poll() is not None, "clean exit")
            assert process.returncode == 0, process.returncode
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            selector.close()
            os.close(master)
            if slave is not None:
                os.close(slave)
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    print("Installed TUI: native startup, identical-body retries, reviewed apply, safe config, saved-theme fallback and clean exit passed")


if __name__ == "__main__":
    main()
