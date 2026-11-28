---
name: publish-app
description: Build microfactory as an artifact that installs as a desktop app, and publish it (first time) or publish a new version to the same artifact (every time after) — and likewise its shareable edition, a second artifact that asks for no access to a computer. Use when the user asks to compile, build, package, publish, ship or update the installable app or the shareable page.
---

# Publish the installable app

microfactory is delivered as a Claude **artifact with the `desktop`
capability**: opened in the Claude desktop app it offers "Install as app",
and the installed app runs the viewer with access to the files and
programs on that computer. This is the whole, repeatable procedure for
making that artifact from the repository as it stands. Do the steps in
order; stop and report if one fails.

There is a second artifact, the **shareable edition**: the same page with
no access to anyone's computer, to give to other people as a link. It is
built and published by the steps under "The shareable edition" below —
ALWAYS as an artifact of its own. Which of the two the user means: "the
app", "install", "update the app" is the installable one; "share", "a
link for others", "the public page" is the shareable one; "publish
everything" is both, the installable one first.

## 1. Check

Run `./scripts/check.sh`. It must end `check: OK`. Do not publish a tree
that fails its checks.

## 2. Build

Run `node scripts/build-artifact.mjs`. It writes `dist/artifact/`:

- `index.html` — the page (the viewer's markup and styles, the desktop
  manifest asking for `full-access`, the entry `viewer/desktop.js`);
- `viewer/*.js` — the page's code;
- `publish.json` — the arguments for the publish call.

- `ws/files.json` and `ws/b/*.txt` — the workspace pack: the files a new
  workspace is made of (local programs, guides, robot, the starter
  application named in `artifact.json`), meshes as separate files.

Beside it, `dist/artifact-report.txt` lists every file that went in.
**Read that report before publishing**: check that nothing is there that
should not be given to other people, and that no mesh carries text other
than the tool's own name.

What may go in is decided by the build and nowhere else: only files
tracked by git (a `viewer/*.js` git does not know is left out, and the
build says so); of `applications/`, only the starter; a mesh only when
every byte of it is accounted for as geometry. A build whose files
differ from the commit is stamped `<commit>+dirty` and says which files
differ: commit first, then build what is published. Never work around a
refusal of the build to get a file in — attachments, conversations,
uncommitted CAD, other applications and any path of this machine stay
out, whatever the reason.

## 3. Publish

Read `dist/artifact/publish.json` and call the **Artifact** tool with
`action: "publish"` and, from that file:

- `file_path` and `files` exactly as given;
- `title` and `description` as given.

Then find WHICH artifact this checkout publishes to. Two files in the
repository root can name one: `artifact.local.json` (not tracked: this
computer's own artifact) and `artifact.json` (tracked: the artifact of the
project's author, and the `starter` list — which everyone uses).

1. **`artifact.local.json` exists**: its `"url"` is the artifact. Publish
   a new version of it (below).
2. **Otherwise, `artifact.json` has a `"url"`**: read that artifact once
   (`action: "read"`, that `url`). If the result says this person owns it
   or can edit it ("writer"), it is the artifact: publish a new version of
   it. If the read is refused, or shows an artifact they can only view,
   this checkout was installed by someone other than the author: make
   their own (the first publish, below). Never try to publish to an
   artifact the person cannot edit, and never ask its owner for access —
   an app with full access only works for the organization that published
   it, so a copy of their own is the right result, not a fallback.
3. **Neither names one**: the first publish.

- **A new version**: pass the `url`, so the installed apps update from
  it. The artifact must have been read once in this conversation
  (`action: "read"`, the same `url`), as the tool requires. Do not pass
  `icon`. Pass `capabilities` as given (`{"desktop": {}}`).
- **The first publish**: omit `url`, pass `capabilities` and `icon` as
  given. Then record the returned URL so the next run updates this
  artifact instead of creating another:
  - when `artifact.json` had no `"url"` (the project's own first
    publish): add `"url": "<the url>"` to `artifact.json`, keeping its
    other fields, and commit that file;
  - when it had one that is not this person's (case 2): write
    `artifact.local.json` as `{"url": "<the url>"}`. Leave
    `artifact.json` as it is and commit nothing.

If the publish is refused for a conflict (someone published in between),
read the artifact again and publish again; never pass `force`.

## 4. Tell the user

In a few lines:

- the artifact's link, and that this was a first publish (and, in case 2
  above, that it is the person's own copy of the app, private to them) or
  a new version
  (with the commit from `publish.json` → `build.commit`);
- how to install: open the link **in the Claude desktop app** → the
  artifact's menu → **Install as app**. An installed app picks a new
  version up by itself; it asks for access again once per new version;
- the first run asks where the **workspace folder** should be and makes it
  (**Create new**); that computer needs `python3`, `node` and the `claude`
  CLI, and no access to the repository;
- anything that failed or was skipped.

Sharing the artifact with other people, or making it public, is not part of
this step and not something this tool can do: say so if asked. `full-access`
is only granted on an artifact of the person's own organization — what is
made for other people is the shareable edition, below.

## The shareable edition

A separate artifact with its own address. **Never publish it to the
installable app's URL, and never the other way round**: a version
published without the `desktop` capability takes full access away from
every installed app, and a share page published with it would ask
strangers for their computer. Each edition has its own folder, its own
`publish.json` and its own record of where it lives:

| | build | folder | report | recorded as |
|---|---|---|---|---|
| installable | `node scripts/build-artifact.mjs` | `dist/artifact/` | `dist/artifact-report.txt` | `"url"` |
| shareable | `node scripts/build-artifact.mjs --share` | `dist/share/` | `dist/share-report.txt` | `"share": {"url"}` |

1. **Check**, as in step 1 (once is enough when both are published).
2. **Build**: `node scripts/build-artifact.mjs --share`. This build is
   REFUSED unless the working tree is exactly its commit (no carried
   file changed, no untracked `viewer/*.js`): the link goes to anyone, so
   commit first. `--dirty` builds anyway, for trying out uncommitted
   work — never publish a build stamped `+dirty`. It writes
   `dist/share/`: the page (no desktop manifest; the entry
   `viewer/share.js`), `viewer/*.js` without the installed app's own
   modules, `ws/files.json` and `ws/b/*.txt` — only what the page reads:
   the robot, the starter application(s), the guides and recipes, the
   step API types, meshes gzip'd — and `ws/mujoco.wasm.txt`, MuJoCo's
   compiled physics from `node_modules` (run `npm install` first if the
   build says it is missing). **Read `dist/share-report.txt` before
   publishing**, with more care than the other one: this page is meant
   for people outside the organization, and everything in it is given to
   them. The same rule holds: never work around a refusal of the build.
3. **Publish** from `dist/share/publish.json`: `file_path`, `files`,
   `title` and `description` exactly as given, and `capabilities` as
   given (`{"sample": {"images": true}, "downloads": true}`) on EVERY
   publish, first or later. Which artifact, by the same three cases as
   in step 3, read on the `share` record:
   1. `artifact.local.json` has `"share": {"url": …}`: a new version of
      that one.
   2. Otherwise `artifact.json` has `"share": {"url": …}`: read it once;
      if this person can edit it ("writer"), a new version of it; if
      not, their own first publish.
   3. Neither: the first publish.

   A new version: pass that `url` (read once in this conversation), no
   `icon`. The first publish: omit `url`, pass `icon`; then record the
   returned URL — in `artifact.json` as `"share": {"url": "<the url>"}`
   beside its other fields (the project's own; commit it), or, for
   someone who is not the author, in `artifact.local.json`, keeping
   what is there (`{"url": "…", "share": {"url": "<the url>"}}`; commit
   nothing). Before publishing, compare the URL you are about to pass
   with the OTHER edition's: if they are the same, stop — a record is
   wrong. A conflict: read again, publish again; never `force`.
4. **Tell the user**:
   - the link, first publish or new version (with `build.commit`);
   - that it opens in a browser or in Claude as it is: nothing to
     install, no python, no node. What a visitor changes is kept in
     their own browser only — **Export** is how they keep or send it —
     and the assistant in its chat answers on the visitor's own Claude
     account;
   - what it does not have: the CAD pipeline, web lookups, git;
   - that a newly published artifact is private: giving it to other
     people, or making it public, is done by the person in the
     artifact's own share controls — not by this step, and not
     something this tool can do;
   - anything that failed or was skipped.

`test/share.test.mjs` covers the build, the page engine over the built
pack and a step run to its end on it. What it cannot cover is the
hosted page itself: after a first publish, and after a change to
`viewer/share.js` or the `viewer/page-*.js` modules, ask the user to
open the link and try it — the scene loads, a step runs, a message to
the assistant is answered, Export saves a file and Import takes it
back.

## What cannot be checked here

The desktop API exists only inside the installed app, so nothing in this
repository can run it. `test/desktop.test.mjs` covers the bridge to the
engine and what the build ships; the installed app's own behaviour (its
permission dialogs, its frame's restrictions) has to be tried by installing
it. If the user reports a problem there, the setup screen's detail text and
the app's console are where the cause shows.
