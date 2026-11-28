"""The viewer's chat: one conversation with one agent, about the open application.

The agent is described in guides/agent.md — a few header lines (name, an
opening hint, extra tools) and below them how it works, which becomes its
instructions. The other files in guides/ describe how each KIND of work is
done (planning, geometry, steps, buying, costing): the agent is given their
list and reads the one that fits before it starts on work of that kind.

Each message runs the Claude Code CLI (`claude`, must be installed and
signed in) headless in the repository root, continuing the conversation.
The agent reads the project's own instructions (CLAUDE.md), edits files,
and the page hot-reloads on its changes.

What the agent may do without asking: read and search the repository, edit
and create files in it, and run ./scripts/check.sh — plus the extra tools
guides/agent.md asks for, but only those named in EXTRA_TOOLS below, and
whatever your own Claude Code settings already allow (read-only shell
commands such as ls and cat, for instance). Anything else is refused: there
is nobody to ask in a headless run.
"""
import json
import os
import re
import shutil
import subprocess
import threading

ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write",
                 "Bash(./scripts/check.sh)", "Bash(./scripts/check.sh:*)"]
# what guides/agent.md may add with its `tools:` line — nothing else.
# Bash(node:*) is the whole geometry pipeline: the repo's own scripts in
# scripts/ (model, inspect, look, mesh) and the per-application generators
# in applications/*/print/. It is running programs on this machine — the
# installed application is meant to (CLAUDE.md, Goal).
EXTRA_TOOLS = {"WebSearch", "WebFetch", "Bash(node:*)"}

# the one agent's conversation is kept under this name (chats/<AGENT>.json)
AGENT = "assistant"

# The models the chat offers, as the CLI names them (an alias is always the
# latest model of its family that this Claude Code offers). "" leaves the
# choice to the CLI's own setting. The page sends an id with each message;
# only these are passed on. `family` is what is shown until the exact model
# behind the alias is known (see Models).
MODELS = [
    {"id": "", "family": "Default", "note": "the model Claude Code is set to use"},
    {"id": "fable", "family": "Fable", "note": "most capable, for hard problems"},
    {"id": "opus", "family": "Opus", "note": "strong at long, careful work"},
    {"id": "sonnet", "family": "Sonnet", "note": "fast, for everyday tasks"},
    {"id": "haiku", "family": "Haiku", "note": "fastest, for quick answers"},
]


def model_label(model_id):
    """'claude-haiku-4-5-20251001' -> 'Haiku 4.5'; 'claude-fable-5' -> 'Fable 5';
    'claude-3-5-sonnet-20241022' -> 'Sonnet 3.5'. A name that does not look
    like a model's comes back as it is."""
    core = re.sub(r"\[.*?\]", "", str(model_id or "")).strip()
    parts = [p for p in core.split("-") if p and p != "claude"]
    words = [p for p in parts if not p.isdigit()]
    nums = [p for p in parts if p.isdigit() and len(p) < 6]        # a date (20251001) is not a version
    if not str(model_id or "").startswith("claude-") or len(words) != 1:
        return str(model_id or "")
    return (words[0].capitalize() + " " + ".".join(nums)).strip()


class Models:
    """Which exact model stands behind each alias, on this computer.

    The CLI says which model it runs in the first line it prints, before
    any answer. So each alias is started once with a one-word message and
    stopped as soon as that line arrives. The answers are kept in
    .chat-models.json, for the CLI version they were read from: a new
    version of Claude Code is asked again."""

    def __init__(self, root):
        self.path = os.path.join(root, ".chat-models.json")
        self.lock = threading.Lock()
        self.known = {}           # alias -> model id
        self.started = False
        self.done = False

    def _cli_version(self):
        try:
            return subprocess.run([shutil.which("claude"), "--version"], stdin=subprocess.DEVNULL,
                                  capture_output=True, text=True, timeout=20).stdout.strip()
        except (OSError, subprocess.SubprocessError, TypeError):
            return ""

    def _ask(self, alias):
        cmd = [shutil.which("claude"), "-p", "--output-format", "stream-json", "--verbose"]
        if alias:
            cmd += ["--model", alias]
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT")}
        proc = None
        try:
            proc = subprocess.Popen(cmd, env=env, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            killer = threading.Timer(20, proc.kill)
            killer.start()
            proc.stdin.write("ok")
            proc.stdin.close()
            for line in proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get("type") == "system" and msg.get("model"):
                    return str(msg["model"])
                if msg.get("type") in ("assistant", "result"):
                    break
        except OSError:
            pass
        finally:
            if proc is not None:
                proc.kill()
                try:
                    killer.cancel()
                except NameError:
                    pass
        return None

    def learn(self, alias, model_id):
        """A real turn said which model it ran on: remember it."""
        if not model_id or not any(m["id"] == alias for m in MODELS):
            return
        with self.lock:
            if self.known.get(alias) == model_id:
                return
            self.known[alias] = model_id
        self._save()

    def _save(self):
        try:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump({"cli": getattr(self, "cli", ""), "models": self.known}, f)
        except OSError:
            pass

    def _resolve(self):
        self.cli = self._cli_version()
        try:
            with open(self.path, encoding="utf-8") as f:
                saved = json.load(f)
            if saved.get("cli") == self.cli and isinstance(saved.get("models"), dict):
                with self.lock:
                    self.known = {**saved["models"], **self.known}
        except (OSError, ValueError):
            pass
        todo = [m["id"] for m in MODELS if m["id"] not in self.known]

        def one(alias):
            got = self._ask(alias)
            if got:
                with self.lock:
                    self.known[alias] = got
        threads = [threading.Thread(target=one, args=(a,), daemon=True) for a in todo]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        if todo:
            self._save()
        self.done = True

    def offer(self):
        """The list for the page: every option with the model's name and number."""
        with self.lock:
            if not self.started and shutil.which("claude"):
                self.started = True
                threading.Thread(target=self._resolve, daemon=True).start()
            known = dict(self.known)
        out = []
        for m in MODELS:
            exact = model_label(known.get(m["id"], ""))
            label = (f"Default ({exact})" if exact else "Default") if m["id"] == "" else (exact or m["family"])
            out.append({"id": m["id"], "label": label, "model": exact, "note": m["note"]})
        return {"models": out, "models_ready": self.done or not shutil.which("claude")}

BRIEF = """You are answering from the chat inside the microfactory viewer: the \
one assistant of this project. The user is looking at the 3D cell in \
their browser while they talk to you; the page reloads by itself whenever \
you save a file. Follow the rules in CLAUDE.md and AGENTS.md. You cannot see \
or drive the viewer. Each message starts with a [viewer: ...] line giving \
the application open in the viewer, the step selected and its last status \
line; "the application" means that one unless the user names another. \
An application is a folder: application.json (the manifest, with the loop), \
layout.json (what stands where), grippers/<id>/ and items/<id>/ (a description \
and its meshes each), steps/, robots/, print/, notes/ (where you keep \
your notes) and materials/. Files the user attaches are saved in \
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

How you work:

%(role)s

The guides — read the one that fits BEFORE starting work of that kind:
%(guides)s"""


def _front(text):
    """A Markdown file's header lines (key: value between --- lines) and its body."""
    meta, body = {}, text
    m = re.match(r"---\n(.*?)\n---\n?(.*)", text, re.S)
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            key, sep, val = line.partition(":")
            if sep:
                meta[key.strip()] = val.strip().strip('"')
    return meta, body


def load_guides(root):
    """The task guides in guides/ (every .md but agent.md): [{file, title, when}], in their order."""
    out = []
    gdir = os.path.join(root, "guides")
    for fn in sorted(os.listdir(gdir)) if os.path.isdir(gdir) else []:
        if not fn.endswith(".md") or fn == "agent.md":
            continue
        try:
            with open(os.path.join(gdir, fn), encoding="utf-8") as f:
                meta, _ = _front(f.read())
        except OSError:
            continue
        try:
            order = float(meta.get("order", 99))
        except ValueError:
            order = 99.0
        out.append({"file": f"guides/{fn}", "title": meta.get("title", fn[:-3]), "when": meta.get("when", ""), "order": order})
    out.sort(key=lambda g: (g["order"], g["file"]))
    return [{k: g[k] for k in ("file", "title", "when")} for g in out]


def load_agent(root):
    """The agent, from guides/agent.md and the list of guides: {name, hint, tools, brief}.
    Re-read on use, so editing a guide takes effect with the next message."""
    try:
        with open(os.path.join(root, "guides", "agent.md"), encoding="utf-8") as f:
            meta, body = _front(f.read())
    except OSError:
        meta, body = {}, ""
    asked = [t.strip() for t in meta.get("tools", "").split(",") if t.strip()]
    guides = load_guides(root)
    listing = "\n".join(f"- {g['file']} — {g['title']}: {g['when']}" for g in guides) or "- (none)"
    return {
        "name": meta.get("name", "Assistant"),
        "hint": meta.get("hint", ""),
        "tools": [t for t in asked if t in EXTRA_TOOLS],
        "guides": guides,
        "brief": BRIEF % {"role": body.strip(), "guides": listing},
    }


class Chats:
    """One conversation PER APPLICATION, kept on disk.

    A conversation is what was said and done, as a list of events, in
    applications/<application>/chats/assistant.json — so it survives the
    server restarting, belongs to the application it is about, and goes
    along when the application is exported. The CLI session that lets the
    agent REMEMBER the conversation is local to this machine and is kept
    apart, in .chat-sessions.json at the repository root."""

    def __init__(self, root):
        self.root = root
        self.chats = {}
        self.lock = threading.Lock()
        self.sessions_path = os.path.join(root, ".chat-sessions.json")
        self.models = Models(root)

    def agent(self):
        """What the page needs to draw the chat (no instructions)."""
        a = load_agent(self.root)
        return {"name": a["name"], "hint": a["hint"], "guides": a["guides"], **self.models.offer()}

    def get(self, app):
        """The conversation about the application `app` (its folder name), or None if there is none such."""
        app_dir = os.path.join(self.root, "applications", app or "")
        if (not app or app != os.path.basename(app) or app in (".", "..")
                or not os.path.isfile(os.path.join(app_dir, "application.json"))):
            return None
        with self.lock:
            if app not in self.chats:
                store = os.path.join(app_dir, "chats", AGENT + ".json")
                _adopt(app_dir, store, self.sessions_path, app)
                self.chats[app] = Chat(self.root, store=store, sessions=(self.sessions_path, f"{app}/{AGENT}"))
            chat = self.chats[app]
        chat.agent = load_agent(self.root)
        chat.learn = self.models.learn
        return chat

    def available(self):
        return shutil.which("claude") is not None


def _adopt(app_dir, store, sessions_path, app):
    """An application made when the chat had several agents kept one
    conversation each. The single conversation continues the main one (the
    Lead engineer's): its file and its session take the new name, once. The
    other agents' files stay where they are, as a record."""
    old = os.path.join(app_dir, "chats", "lead-engineer.json")
    if os.path.exists(store) or not os.path.exists(old):
        return
    try:
        os.rename(old, store)
        with _files:
            try:
                with open(sessions_path, encoding="utf-8") as f:
                    table = json.load(f)
            except (OSError, ValueError):
                return
            if f"{app}/lead-engineer" in table:
                table[f"{app}/{AGENT}"] = table.pop(f"{app}/lead-engineer")
                _write_json(sessions_path, table)
    except OSError:
        pass


_files = threading.Lock()           # one writer at a time for the small state files


def _write_json(path, obj):
    """Write a small JSON file whole, so a reader never sees half of it."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


class Chat:
    def __init__(self, root, cond=None, store=None, sessions=None):
        self.root = root
        self.agent = None           # set by Chats.get: the agent as its guides describe it now
        self.events = []            # everything the page shows, in order
        self.session = None         # CLI session id, to continue the talk
        self.proc = None
        self.epoch = 0              # bumped by "new chat": tells pages to start over
        self.cond = cond or threading.Condition()
        self.store = store          # the file the events are kept in
        self.sessions = sessions    # (file, key) of this conversation's CLI session id
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
                    _write_json(self.store, {"events": self.events})
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
        """Start the CLI for one turn; `resume` continues its own session.
        The turn runs on `self.model` (one of MODELS) when one was chosen."""
        cmd = [shutil.which("claude"), "-p", "--output-format", "stream-json", "--verbose",
               "--permission-mode", "acceptEdits",
               "--append-system-prompt", self.agent["brief"],
               "--allowedTools", *ALLOWED_TOOLS, *self.agent["tools"]]
        if getattr(self, "model", ""):
            cmd += ["--model", self.model]
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

    def send(self, text, context="", files=(), model=""):
        text = (text or "").strip()
        files = list(files)
        model = model if any(m["id"] == model for m in MODELS) else ""
        if not text and not files:
            return "empty message"
        with self.cond:
            if self.proc is not None:
                return "the agent is still working"
            if not shutil.which("claude"):
                return "the `claude` command was not found — install Claude Code and sign in"
            earlier = list(self.events)             # the conversation before this message
            self.model = model
            try:
                self.proc = self._spawn(self.session)
            except OSError as e:
                return f"could not start the agent: {e}"
            proc, resumed = self.proc, bool(self.session)
            self.events.append({"type": "user", "text": text, "files": files})
            self._save()
            self.cond.notify_all()
        prompt = f"[viewer: {context}]\n{text}" if context else text
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
            if msg.get("type") == "system" and msg.get("model") and getattr(self, "learn", None):
                self.learn(getattr(self, "model", ""), str(msg["model"]))     # which model this option really is
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
