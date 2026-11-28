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
line; "the application" means that one unless the user names another. \
An application is a folder: application.json (the manifest, with the loop), \
layout.json (what stands where), grippers/<id>/ and items/<id>/ (a description \
and its meshes each), steps/, robots/, print/, notes/ (where the agents keep \
their notes) and materials/. Files the user attaches are saved in \
applications/<application>/materials/ \
and listed at the end of the message: open them (Read shows images). Keep \
replies short and plain; no headings. Do not commit or push.

When you need the user to decide something and can name the likely answers, \
do not write the questions as prose: end your message with a questions block, \
which the chat shows as buttons. It must be the LAST thing in the message:

```questions
[{"question": "Which package?", "options": [
   {"label": "DIP-16", "description": "16 pins, 19.3 x 6.4 mm body", "recommended": true},
   {"label": "DIP-8", "description": "8 pins, 9.3 x 6.4 mm body"}]},
 {"question": "How do the parts arrive?", "options": [
   {"label": "Antistatic tube"}, {"label": "Loose on a tray"}, {"label": "Design a tray"}]}]
```

Rules for it: valid JSON; at most 4 questions; 2 to 4 options each; labels of a \
few words; an optional one-line description; mark the option you would choose \
with "recommended": true (one per question, and only when you have a reason); \
add "multi": true to a question where several options may be picked. Do not \
add an "other" option — the user can always type their own answer. Say before \
the block, in a sentence or two, why you are asking. Ask only what you cannot \
find out or sensibly decide yourself.

Your role:

%(role)s"""


HANDOFF = """

Handing work to a colleague. You can give a task to another agent yourself: \
end your message with a handoff block and the chat runs it — do NOT ask the \
user to copy a task to another agent. The colleagues you can hand to:
%(roster)s

```handoff
[{"to": "cad-designer", "task": "In the application dippackage: ... (everything they need)"},
 {"to": "programmer", "task": "..."}]
```

How it works, so write the tasks accordingly: each task is sent to that \
agent's own chat as a new message. The colleague sees NOTHING of this \
conversation — only your task text — so name the application, the files, the \
numbers and decisions they need, and what "done" means. Tasks run one after \
another in the order you list them, each starting when the one before has \
finished (so put geometry before the steps that use it); if one fails the \
rest are not started. You are not woken when they finish: their results are \
given to you with the user's next message, and the user sees each colleague's \
reply in that colleague's chat. Hand off only work that is ready to start — \
if you still need an answer from the user, ask first (a questions block) and \
hand off after. At most 5 tasks in a block; valid JSON; the block goes last \
in the message (after it, nothing). Say in a sentence before it what you are \
handing to whom."""

_HANDOFF_BLOCK = re.compile(r"```handoff\s*\n(.*?)```", re.S)


def parse_handoffs(text, allowed):
    """The tasks an agent's message hands to colleagues: [{to, task}], only
    for agent ids in `allowed`. A block that cannot be read gives none."""
    m = _HANDOFF_BLOCK.search(text or "")
    if not m:
        return []
    try:
        raw = json.loads(m.group(1))
    except ValueError:
        return []
    out = []
    for h in raw if isinstance(raw, list) else [raw]:
        if (isinstance(h, dict) and h.get("to") in allowed and isinstance(h.get("task"), str)
                and h["task"].strip()):
            out.append({"to": h["to"], "task": h["task"].strip()})
    return out[:5]


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
            "hands_off": meta.get("hands_off", "").lower() == "true",
            "brief": BRIEF % {"name": name, "role": body.strip()},
        })
    out.sort(key=lambda a: (a["order"], a["id"]))
    # an agent that may hand work on is told how, and to whom
    for a in out:
        if a["hands_off"]:
            roster = "\n".join(f'- "{o["id"]}" — {o["name"]}: {o["role"]}' for o in out if o["id"] != a["id"])
            a["brief"] += HANDOFF % {"roster": roster}
    return out


class Chats:
    """One conversation per agent PER APPLICATION, kept on disk.

    A conversation is what was said and done, as a list of events, in
    applications/<application>/chats/<agent>.json — so it survives the
    server restarting, belongs to the application it is about, and goes
    along when the application is exported. The CLI session that lets the
    agent REMEMBER the conversation is local to this machine and is kept
    apart, in .chat-sessions.json at the repository root.

    Agents are re-read from agents/ on use, so editing a description takes
    effect with the next message."""

    def __init__(self, root):
        self.root = root
        self.chats = {}
        self.lock = threading.Lock()
        # one condition for all conversations: a page following one agent
        # still hears at once that another has answered
        self.cond = threading.Condition()
        self.sessions_path = os.path.join(root, ".chat-sessions.json")

    def agents(self):
        """What the page needs to draw the profiles (no instructions)."""
        return [{k: a[k] for k in ("id", "name", "role", "initials", "color", "hint")} for a in load_agents(self.root)]

    def get(self, app, agent_id):
        """The conversation of `agent_id` about the application `app` (its
        folder name), or None if there is no such agent or application."""
        agent = next((a for a in load_agents(self.root) if a["id"] == agent_id), None)
        app_dir = os.path.join(self.root, "applications", app or "")
        if (agent is None or not app or app != os.path.basename(app) or app in (".", "..")
                or not os.path.isfile(os.path.join(app_dir, "application.json"))):
            return None
        with self.lock:
            key = (app, agent_id)
            if key not in self.chats:
                self.chats[key] = Chat(self.root, self.cond,
                                       store=os.path.join(app_dir, "chats", agent_id + ".json"),
                                       sessions=(self.sessions_path, f"{app}/{agent_id}"),
                                       colleagues=lambda other, app=app: self.get(app, other))
            chat = self.chats[key]
        chat.agent = agent
        return chat

    def _of(self, app):
        # every agent's conversation about this application, loaded if it is on disk
        return {a["id"]: c for a in load_agents(self.root) for c in [self.get(app, a["id"])] if c}

    def answers(self, app):
        """How many answers each conversation holds — the page marks an agent
        whose count has grown since the user last looked at it."""
        return {i: sum(1 for e in c.events if e.get("type") in ("text", "error")) for i, c in self._of(app).items()}

    def busy(self, app):
        return [i for i, c in self._of(app).items() if c.running()]

    def available(self):
        return shutil.which("claude") is not None


_files = threading.Lock()           # one writer at a time for the small state files


def _write_json(path, obj):
    """Write a small JSON file whole, so a reader never sees half of it."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


class Chat:
    def __init__(self, root, cond=None, store=None, sessions=None, colleagues=None):
        self.root = root
        self.agent = None           # set by Chats.get: this conversation's agent
        self.events = []            # everything the page shows, in order
        self.session = None         # CLI session id, to continue the talk
        self.proc = None
        self.epoch = 0              # bumped by "new chat": tells pages to start over
        self.cond = cond or threading.Condition()
        self.store = store          # the file the events are kept in
        self.sessions = sessions    # (file, key) of this conversation's CLI session id
        self.colleagues = colleagues  # agent id -> that agent's conversation about the same application
        self.inbox = []             # what colleagues reported back, for this agent's next turn
        self.context = ""           # the viewer line of the last message, passed on with a handoff
        self._load()

    # ---- on disk ----
    def _load(self):
        if self.store:
            try:
                with open(self.store, encoding="utf-8") as f:
                    events = json.load(f).get("events", [])
                self.events = [e for e in events if isinstance(e, dict) and e.get("type")]
            except (OSError, ValueError, AttributeError):
                self.events = []
            # the server stopped while the agent was working: say so, or the
            # conversation would end in the middle of a sentence
            if self.events and self.events[-1]["type"] not in ("done", "error", "note"):
                self.events += [{"type": "error", "text": "interrupted: the server was restarted while the agent was working"},
                                {"type": "done"}]
        if self.sessions:
            try:
                with open(self.sessions[0], encoding="utf-8") as f:
                    self.session = json.load(f).get(self.sessions[1])
            except (OSError, ValueError, AttributeError):
                self.session = None

    def _save(self):
        """Keep the events (call with self.cond held, or from the one thread running the agent)."""
        if not self.store:
            return
        try:
            with _files:
                if self.events:
                    _write_json(self.store, {"agent": self.agent["id"] if self.agent else None, "events": self.events})
                elif os.path.exists(self.store):
                    os.remove(self.store)
        except OSError:
            pass                    # a chat that cannot be saved still works

    def _save_session(self):
        if not self.sessions:
            return
        path, key = self.sessions
        try:
            with _files:
                try:
                    with open(path, encoding="utf-8") as f:
                        table = json.load(f)
                except (OSError, ValueError):
                    table = {}
                if table.get(key) == self.session:
                    return
                if self.session:
                    table[key] = self.session
                else:
                    table.pop(key, None)
                _write_json(path, table)
        except OSError:
            pass

    # ---- state the page polls ----
    def _add(self, **ev):
        with self.cond:
            self.events.append(ev)
            self._save()
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
    def _spawn(self, resume):
        """Start the CLI for one turn; `resume` continues its own session."""
        cmd = [shutil.which("claude"), "-p", "--output-format", "stream-json", "--verbose",
               "--permission-mode", "acceptEdits",
               "--append-system-prompt", self.agent["brief"],
               "--allowedTools", *ALLOWED_TOOLS, *self.agent["tools"]]
        if resume:
            cmd += ["--resume", resume]
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT")}
        return subprocess.Popen(cmd, cwd=self.root, env=env, text=True,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def _history(self, events, limit=24_000):
        """The saved conversation as background for an agent that has no
        session of its own for it — after an import on another machine, or
        once its session is gone. The latest part, if it is long."""
        lines = []
        for e in events:
            kind, text = e.get("type"), str(e.get("text", "")).strip()
            if kind == "user":
                files = "".join(f"\n  [attached: {p}]" for p in e.get("files") or [])
                who = f"THE {str(e['from']).upper()} (handing you a task)" if e.get("from") else "USER"
                lines.append(f"{who}: {text}{files}")
            elif kind == "note":
                lines.append(f"  ({text})")
            elif kind == "text":
                lines.append(f"YOU: {text}")
            elif kind == "tool":
                lines.append(f"  (you: {text})")
            elif kind == "error":
                lines.append(f"  (the turn ended with an error: {text})")
        body = "\n".join(lines)
        if not body:
            return ""
        cut = len(body) > limit
        if cut:
            body = body[-limit:]
            body = body[body.find("\n") + 1:]          # start at a whole line
        return ("[Background — your earlier conversation with the user about this application, as saved "
                "with it. You have no memory of it yourself, so read it and carry on from where it ends. "
                "Files you changed then are on disk as you left them; check them rather than trusting this "
                "record." + (" Only the latest part is shown." if cut else "") + "\n\n" + body +
                "\n\nEnd of the earlier conversation. The user's new message follows.]\n\n")

    def send(self, text, context="", files=(), sender=None):
        """A message for this agent: from the user, or — with `sender`, an
        agent's name — a task handed over by a colleague."""
        text = (text or "").strip()
        files = list(files)
        if not text and not files:
            return "empty message"
        with self.cond:
            if self.proc is not None:
                return "the agent is still working"
            if not shutil.which("claude"):
                return "the `claude` command was not found — install Claude Code and sign in"
            earlier = list(self.events)             # the conversation before this message
            try:
                self.proc = self._spawn(self.session)
            except OSError as e:
                return f"could not start the agent: {e}"
            proc, resumed = self.proc, bool(self.session)
            self.events.append({"type": "user", "text": text, "files": files, **({"from": sender} if sender else {})})
            self._save()
            self.cond.notify_all()
            reports, self.inbox = self.inbox, []
        self.context = context
        prompt = f"[viewer: {context}]\n{text}" if context else text
        if sender:
            prompt = (f"[This task was handed to you by the {sender}, not typed by the user. Do it as you would a "
                      f"request from the user; the user reads your reply in this chat.]\n" + prompt)
        if reports:
            # what the colleagues it handed work to have answered since its last turn
            prompt = ("[Since your last message, the colleagues you handed work to have reported:\n\n"
                      + "\n\n".join(reports) + "]\n\n" + prompt)
        if files:
            # the agent opens them itself (Read shows images)
            prompt += "\n\n[attached by the user, saved in the repository — read them:\n" + \
                "\n".join(f"  {p}" for p in files) + "]"
        # with a session the agent remembers; without one it gets the saved conversation to read
        background = self._history(earlier)
        threading.Thread(target=self._run, args=(proc, prompt, resumed, background), daemon=True).start()
        return None

    def stop(self):
        proc = self.proc
        if proc is not None:
            proc.terminate()

    # ---- handing work to colleagues ----
    def _last_turn(self):
        """The events of the latest turn: from its user message on."""
        i = max((k for k, e in enumerate(self.events) if e.get("type") == "user"), default=0)
        return self.events[i:]

    def _hand_off(self, epoch):
        """After a clean turn: if this agent may hand work on and its message
        ends with a handoff block, run those tasks in its colleagues' chats."""
        if not (self.agent and self.agent.get("hands_off") and self.colleagues):
            return
        texts = [e["text"] for e in self._last_turn() if e.get("type") == "text"]
        allowed = {a["id"] for a in load_agents(self.root)} - {self.agent["id"]}
        tasks = parse_handoffs(texts[-1] if texts else "", allowed)
        if tasks:
            threading.Thread(target=self._relay, args=(tasks, epoch, self.agent["name"], self.context), daemon=True).start()

    def _relay(self, tasks, epoch, me, context, patience=1800):
        """Give the tasks to the colleagues one after another, each in its own
        chat with only the task as its prompt; note in this chat what happened
        and keep each reply for this agent's next turn. Stops at a failure."""
        import time
        for n, t in enumerate(tasks):
            if epoch != self.epoch:
                return                              # this conversation was cleared
            other = self.colleagues(t["to"])
            if other is None:
                self._add(type="note", text=f"could not hand over to {t['to']}: no such agent")
                break
            name = other.agent["name"]
            waited = 0
            while other.running() and waited < patience:      # it is busy with something else
                time.sleep(0.25)
                waited += 0.25
            err = other.send(t["task"], context, sender=me)
            if err:
                self._add(type="note", text=f"could not hand over to the {name}: {err}", to=t["to"])
                break
            self._add(type="note", text=f"handed to the {name}", to=t["to"])
            while other.running():
                time.sleep(0.25)
            turn = other._last_turn()
            reply = next((e["text"] for e in reversed(turn) if e.get("type") == "text"), "")
            failed = next((e["text"] for e in turn if e.get("type") == "error"), None)
            if failed is not None:
                self.inbox.append(f"{name} — FAILED on the task “{t['task'][:200]}”: {failed}")
                left = len(tasks) - n - 1
                self._add(type="note", text=f"the {name} did not finish ({failed[:120]})"
                          + (f"; {left} later task{'s' if left > 1 else ''} not started" if left else ""), to=t["to"])
                break
            self.inbox.append(f"{name} — done with the task “{t['task'][:200]}”. Its reply:\n{reply[:4000]}")
            self._add(type="note", text=f"the {name} has finished", to=t["to"])

    def new(self):
        self.stop()
        with self.cond:
            self.events = []
            self.session = None
            self.epoch += 1
            self._save()
            self._save_session()
            self.cond.notify_all()

    # ---- one turn of the agent ----
    def _run(self, proc, prompt, resumed=False, background=""):
        epoch = self.epoch
        try:
            said, finished, code, tail = self._turn(proc, prompt if resumed else background + prompt, epoch)
            if resumed and not said and epoch == self.epoch and (code != 0 or not finished):
                # its session could not be continued (it expires; another machine never had it):
                # forget it and start a new one, with the saved conversation as background
                self.session = None
                self._save_session()
                with self.cond:
                    if epoch != self.epoch:
                        return
                    proc = self.proc = self._spawn(None)
                said, finished, code, tail = self._turn(proc, background + prompt, epoch)
            if epoch == self.epoch and not finished:
                self._add(type="error", text="stopped" if code in (-15, 143) else f"the agent exited ({code}) {tail}".strip())
            elif epoch == self.epoch:
                self._hand_off(epoch)
        except Exception as e:              # never leave the chat stuck "running"
            if epoch == self.epoch:
                self._add(type="error", text=f"chat failed: {e}")
        finally:
            with self.cond:
                if self.proc is proc:
                    self.proc = None
                if epoch == self.epoch:
                    self.events.append({"type": "done"})
                    self._save()
                self.cond.notify_all()

    def _turn(self, proc, prompt, epoch):
        """Feed one prompt to a started CLI and relay what it says and does.
        Returns (it said or did something, it finished cleanly, exit code, end of stderr).
        A turn that fails WITHOUT having said anything shows nothing: the caller may try again."""
        err = []
        threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True).start()
        said = finished = False
        failure = None
        proc.stdin.write(prompt)
        proc.stdin.close()
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if epoch != self.epoch:
                continue                      # chat was cleared: drop the rest
            if msg.get("session_id") and msg["session_id"] != self.session and msg.get("type") != "result":
                self.session = msg["session_id"]
                self._save_session()
            kind = msg.get("type")
            if kind == "assistant":
                for block in msg.get("message", {}).get("content", []):
                    if block.get("type") == "text" and block.get("text", "").strip():
                        said = True
                        self._add(type="text", text=block["text"])
                    elif block.get("type") == "tool_use":
                        said = True
                        self._add(type="tool", text=self._describe(block))
            elif kind == "result":
                if msg.get("is_error"):
                    failure = str(msg.get("result") or msg.get("subtype") or "the agent stopped with an error")
                else:
                    finished = True
        code = proc.wait()
        if failure is not None and epoch == self.epoch:
            if said:
                self._add(type="error", text=failure)
                finished = True                 # it has been reported
            else:
                err.append(failure)
        return said, finished, code, "".join(err).strip()[-600:]

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
