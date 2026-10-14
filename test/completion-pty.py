"""Drive TAB through real Bash/readline; never use the user's shell profiles."""

import errno
import fcntl
import json
import os
import pty
import select
import shlex
import signal
import struct
import sys
import tempfile
import termios
import time


def complete(case, completion):
    with tempfile.TemporaryDirectory(prefix="ask-readline-") as scratch:
        args_file = os.path.join(scratch, "args")
        line_file = os.path.join(scratch, "line")
        done_file = os.path.join(scratch, "completed")
        rc = os.path.join(scratch, "bashrc")
        with open(rc, "w", encoding="utf-8") as script:
            script.write("\n".join([
                "PS1='__ASK_READY__> '",
                "PS2='__ASK_CONTINUE__> '",
                "PROMPT_COMMAND=",
                "source " + shlex.quote(completion),
                "bind 'set enable-bracketed-paste off'",
                "bind '\"\\C-i\": complete'",
                "ask() { printf '%s\\0' \"$@\" > \"$ASK_TEST_ARGS\"; : > \"$ASK_TEST_ARGS.done\"; }",
                "_ask_observed_complete() { _ask_complete; declare -p COMP_WORDS COMPREPLY > \"$ASK_TEST_DONE\"; }",
                "complete -F _ask_observed_complete ask",
                "_ask_capture_line() { printf '%s' \"$READLINE_LINE\" > \"$ASK_TEST_LINE\"; : > \"$ASK_TEST_LINE.done\"; }",
                "bind -x '\"\\C-x\\C-r\": _ask_capture_line'",
                "",
            ]))
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("ASK_", "FZF_", "GIT_", "LD_", "DYLD_", "BASH_FUNC_"))
            and key not in ("BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PROMPT_COMMAND", "NODE_OPTIONS")
        }
        env.update({
            "HOME": scratch, "INPUTRC": "/dev/null", "HISTFILE": "/dev/null",
            "TERM": "xterm", "LC_ALL": "C.UTF-8", "ASK_AT_KEY": "0",
            "ASK_FZF": "1" if case["picker"] else "0",
            "ASK_MODELS": case.get("models", ""),
            "ASK_TEST_ARGS": args_file, "ASK_TEST_LINE": line_file, "ASK_TEST_DONE": done_file,
        })
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(case["cwd"])
            os.execvpe("bash", ["bash", "--noprofile", "--rcfile", rc, "-i"], env)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        transcript = bytearray()

        def wait_for(predicate):
            deadline = time.monotonic() + 8
            while not predicate():
                if time.monotonic() > deadline:
                    raise RuntimeError("readline timed out: " + repr(bytes(transcript[-4000:])))
                ready, _, _ = select.select([master], [], [], 0.02)
                if ready:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            raise RuntimeError("bash exited: " + repr(bytes(transcript[-4000:]))) from error
                        raise
                    transcript.extend(chunk)

        try:
            wait_for(lambda: b"__ASK_READY__> " in transcript)
            os.write(master, case["prefix"].encode("utf-8") + b"\t")
            wait_for(lambda: os.path.exists(done_file))
            os.write(master, b"\x18\x12")  # Capture the buffer after readline has quoted it.
            wait_for(lambda: os.path.exists(line_file + ".done"))
            with open(line_file, encoding="utf-8") as stream:
                line = stream.read()
            # Quoted-context cases deliberately complete nothing; the simulated
            # user closes their own quote before pressing ENTER.
            os.write(master, case.get("suffix", "").encode("utf-8") + b"\r")
            wait_for(lambda: os.path.exists(args_file + ".done"))
            with open(args_file, "rb") as stream:
                args = stream.read().split(b"\0")[:-1]
            with open(done_file, encoding="utf-8") as stream:
                trace = stream.read()
            return {"line": line, "args": [arg.decode("utf-8") for arg in args], "trace": trace}
        finally:
            try:
                os.kill(pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
            os.close(master)
            os.waitpid(pid, 0)


payload = json.load(sys.stdin)
print(json.dumps([complete(case, payload["completion"]) for case in payload["cases"]]))
