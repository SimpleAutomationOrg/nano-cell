"""The viewer's chat panel: talk to a coding agent that edits the steps.

Each message runs the Claude Code CLI (`claude`, must be installed and
signed in) headless in the repository root, continuing one conversation.
The agent reads the project's own instructions (CLAUDE.md), edits files,
and the page hot-reloads on its changes.

The conversation lives HERE, in the server, as a list of events; the page
long-polls it. That is what lets the chat survive the page reloading
itself every time the agent saves a file.

What the agent may do without asking: read and search the repository,
edit and create files in it, and run ./scripts/check.sh — plus whatever
your own Claude Code settings already allow (read-only shell commands
such as ls and cat, for instance). Anything else is refused: there is
nobody to ask in a headless run.
"""
import json
import os
import shutil
import subprocess
import threading

ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write",
                 "Bash(./scripts/check.sh)", "Bash(./scripts/check.sh:*)"]

BRIEF = """You are answering from the chat panel inside the nano-cell viewer. \
The user is looking at the 3D cell in their browser while they talk to you; \
the page reloads by itself whenever you save a file. They mostly want to \
change or create steps of the application they have open \
(applications/<application>/steps/<name>/step.json and segments/*.ts) — follow \
the recipes in recipes/ and the rules in CLAUDE.md and AGENTS.md. \
You cannot see or drive the viewer: after a change run ./scripts/check.sh, \
then ask the user to run the step in the viewer and tell you what happened. \
Each message starts with a [viewer: ...] line giving the application open in \
the viewer, the step selected and its last status line. Keep replies short and plain; no \
headings. Do not commit or push."""


class Chat:
    def __init__(self, root):
        self.root = root
        self.events = []            # everything the page shows, in order
        self.session = None         # CLI session id, to continue the talk
        self.proc = None
        self.epoch = 0              # bumped by "new chat": tells pages to start over
        self.cond = threading.Condition()

    # ---- state the page polls ----
    def _add(self, **ev):
        with self.cond:
            self.events.append(ev)
            self.cond.notify_all()

    def running(self):
        return self.proc is not None

    def poll(self, epoch, since, timeout=25):
        with self.cond:
            if epoch == self.epoch and since >= len(self.events):
                self.cond.wait(timeout=timeout)
            if epoch != self.epoch:
                since = 0
            return {"epoch": self.epoch, "events": self.events[since:],
                    "next": len(self.events), "running": self.running(),
                    "available": shutil.which("claude") is not None}

    # ---- actions ----
    def send(self, text, context=""):
        text = (text or "").strip()
        if not text:
            return "empty message"
        with self.cond:
            if self.proc is not None:
                return "the agent is still working"
            cli = shutil.which("claude")
            if not cli:
                return "the `claude` command was not found — install Claude Code and sign in"
            cmd = [cli, "-p", "--output-format", "stream-json", "--verbose",
                   "--permission-mode", "acceptEdits",
                   "--append-system-prompt", BRIEF,
                   "--allowedTools", *ALLOWED_TOOLS]
            if self.session:
                cmd += ["--resume", self.session]
            env = {k: v for k, v in os.environ.items()
                   if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT")}
            try:
                self.proc = subprocess.Popen(
                    cmd, cwd=self.root, env=env, text=True,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            except OSError as e:
                return f"could not start the agent: {e}"
            proc = self.proc
            self.events.append({"type": "user", "text": text})
            self.cond.notify_all()
        prompt = f"[viewer: {context}]\n{text}" if context else text
        threading.Thread(target=self._run, args=(proc, prompt), daemon=True).start()
        return None

    def stop(self):
        proc = self.proc
        if proc is not None:
            proc.terminate()

    def new(self):
        self.stop()
        with self.cond:
            self.events = []
            self.session = None
            self.epoch += 1
            self.cond.notify_all()

    # ---- one turn of the agent ----
    def _run(self, proc, prompt):
        epoch = self.epoch
        err = []
        threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True).start()
        finished = False
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
            for line in proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if epoch != self.epoch:
                    continue                      # chat was cleared: drop the rest
                if msg.get("session_id"):
                    self.session = msg["session_id"]
                kind = msg.get("type")
                if kind == "assistant":
                    for block in msg.get("message", {}).get("content", []):
                        if block.get("type") == "text" and block.get("text", "").strip():
                            self._add(type="text", text=block["text"])
                        elif block.get("type") == "tool_use":
                            self._add(type="tool", text=self._describe(block))
                elif kind == "result":
                    finished = True
                    if msg.get("is_error"):
                        self._add(type="error", text=str(msg.get("result") or msg.get("subtype") or "the agent stopped with an error"))
            code = proc.wait()
            if epoch == self.epoch and not finished:
                tail = "".join(err).strip()[-600:]
                self._add(type="error", text="stopped" if code in (-15, 143) else f"the agent exited ({code}) {tail}".strip())
        except Exception as e:              # never leave the chat stuck "running"
            if epoch == self.epoch:
                self._add(type="error", text=f"chat failed: {e}")
        finally:
            with self.cond:
                if self.proc is proc:
                    self.proc = None
                if epoch == self.epoch:
                    self.events.append({"type": "done"})
                self.cond.notify_all()

    def _describe(self, block):
        """One line saying what the agent is doing, for the transcript."""
        name, inp = block.get("name", "tool"), block.get("input", {}) or {}
        path = inp.get("file_path") or inp.get("path") or ""
        if path.startswith(self.root):
            path = os.path.relpath(path, self.root)
        if name in ("Edit", "Write"):
            return f"{'edits' if name == 'Edit' else 'writes'} {path}"
        if name == "Read":
            return f"reads {path}"
        if name == "Bash":
            return f"runs {str(inp.get('command', '')).replace(self.root + '/', '')[:80]}"
        if name in ("Grep", "Glob"):
            return f"searches {inp.get('pattern', '')}"
        return name
