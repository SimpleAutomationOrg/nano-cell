"""The viewer's chat: talk to the project's agents, each with its own role.

An agent is a Markdown file in agents/ — a few header lines (name, role,
initials, colour, order, an opening hint, extra tools) and below them the
description of the role, which becomes that agent's instructions. Every
agent has its own conversation.

Each message runs the Claude Code CLI (`claude`, must be installed and
signed in) headless in the repository root, continuing that agent's
conversation. The agent reads the project's own instructions (CLAUDE.md),
edits files, and the page hot-reloads on its changes.

The conversations live HERE, in the server, as lists of events; the page
long-polls the one it shows. That is what lets the chat survive the page
reloading itself every time an agent saves a file.

What an agent may do without asking: read and search the repository, edit
and create files in it, and run ./scripts/check.sh — plus the extra tools
its file asks for, but only those named in EXTRA_TOOLS below, and whatever
your own Claude Code settings already allow (read-only shell commands such
as ls and cat, for instance). Anything else is refused: there is nobody to
ask in a headless run.
"""
import json
import os
import re
import shutil
import subprocess
import threading

ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write",
                 "Bash(./scripts/check.sh)", "Bash(./scripts/check.sh:*)"]
# what an agent's file may add with its `tools:` line — nothing else
EXTRA_TOOLS = {"WebSearch", "WebFetch", "Bash(node scripts/step-to-mesh.mjs:*)"}

BRIEF = """You are answering from the chat inside the nano-cell viewer, as \
one of the project's agents: %(name)s. The user is looking at the 3D cell in \
their browser while they talk to you; the page reloads by itself whenever \
you save a file. Follow the rules in CLAUDE.md and AGENTS.md. You cannot see \
or drive the viewer. Each message starts with a [viewer: ...] line giving \
the application open in the viewer, the step selected and its last status \
line; "the application" means that one unless the user names another. Keep \
replies short and plain; no headings. Do not commit or push.

Your role:

%(role)s"""


def load_agents(root):
    """The agents in agents/*.md, in their order: [{id, name, role, initials, color, hint, tools, brief}]."""
    out = []
    adir = os.path.join(root, "agents")
    for fn in sorted(os.listdir(adir)) if os.path.isdir(adir) else []:
        if not fn.endswith(".md"):
            continue
        try:
            with open(os.path.join(adir, fn), encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        meta, body = {}, text
        m = re.match(r"---\n(.*?)\n---\n?(.*)", text, re.S)
        if m:
            body = m.group(2)
            for line in m.group(1).splitlines():
                key, sep, val = line.partition(":")
                if sep:
                    meta[key.strip()] = val.strip().strip('"')
        agent_id = fn[:-3]
        name = meta.get("name", agent_id)
        asked = [t.strip() for t in meta.get("tools", "").split(",") if t.strip()]
        try:
            order = float(meta.get("order", 99))
        except ValueError:
            order = 99.0
        out.append({
            "id": agent_id, "name": name, "role": meta.get("role", ""),
            "initials": (meta.get("initials") or name[:1]).upper()[:2],
            "color": meta.get("color", "#4da3ff") if re.fullmatch(r"#[0-9a-fA-F]{3,8}", meta.get("color", "#4da3ff")) else "#4da3ff",
            "hint": meta.get("hint", ""), "order": order,
            "tools": [t for t in asked if t in EXTRA_TOOLS],
            "brief": BRIEF % {"name": name, "role": body.strip()},
        })
    out.sort(key=lambda a: (a["order"], a["id"]))
    return out


class Chats:
    """One conversation per agent. Agents are re-read from agents/ on use, so
    editing a description takes effect with the next message."""

    def __init__(self, root):
        self.root = root
        self.chats = {}
        self.lock = threading.Lock()

    def agents(self):
        """What the page needs to draw the profiles (no instructions)."""
        return [{k: a[k] for k in ("id", "name", "role", "initials", "color", "hint")} for a in load_agents(self.root)]

    def get(self, agent_id):
        agent = next((a for a in load_agents(self.root) if a["id"] == agent_id), None)
        if agent is None:
            return None
        with self.lock:
            chat = self.chats.setdefault(agent_id, Chat(self.root))
        chat.agent = agent
        return chat

    def busy(self):
        return [i for i, c in list(self.chats.items()) if c.running()]

    def available(self):
        return shutil.which("claude") is not None


class Chat:
    def __init__(self, root):
        self.root = root
        self.agent = None           # set by Chats.get: this conversation's agent
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
                    "next": len(self.events), "running": self.running()}

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
                   "--append-system-prompt", self.agent["brief"],
                   "--allowedTools", *ALLOWED_TOOLS, *self.agent["tools"]]
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
