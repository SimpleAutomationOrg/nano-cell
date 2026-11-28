---
name: publish-app
description: Build microfactory as an artifact that installs as a desktop app, and publish it (first time) or publish a new version to the same artifact (every time after). Use when the user asks to compile, build, package, publish, ship or update the installable app.
---

# Publish the installable app

microfactory is delivered as a Claude **artifact with the `desktop`
capability**: opened in the Claude desktop app it offers "Install as app",
and the installed app runs the viewer with access to the files and
programs on that computer. This is the whole, repeatable procedure for
making that artifact from the repository as it stands. Do the steps in
order; stop and report if one fails.

## 1. Check

Run `./scripts/check.sh`. It must end `check: OK`. Do not publish a tree
that fails its checks.

## 2. Build

Run `node scripts/build-artifact.mjs`. It writes `dist/artifact/`:

- `index.html` — the page (the viewer's markup and styles, the desktop
  manifest asking for `full-access`, the entry `viewer/desktop.js`);
- `viewer/*.js` — the page's code;
- `publish.json` — the arguments for the publish call.

- `ws/files.json` and `ws/b/*.bin` — the workspace pack: the files a new
  workspace is made of (local programs, guides, robot, the starter
  application named in `artifact.json`), meshes as separate files.

Beside it, `dist/artifact-report.txt` lists every file that went in.
**Read that report before publishing**: check that nothing is there that
should not be given to other people, and that no mesh carries text other
than the tool's own name.

What may go in is decided by the build and nowhere else: only files
tracked by git; of `applications/`, only the starter; a mesh only when
every byte of it is accounted for as geometry. Never work around a
refusal of the build to get a file in — attachments, conversations,
uncommitted CAD, other applications and any path of this machine stay
out, whatever the reason.

## 3. Publish

Read `dist/artifact/publish.json` and call the **Artifact** tool with
`action: "publish"` and, from that file:

- `file_path` and `files` exactly as given (the `.bin` entries carry their
  content type);
- `title` and `description` as given.

Then, depending on whether `artifact.json` exists in the repository root:

- **It exists** (the app was published before): pass its `"url"` as `url`,
  so this becomes a new version of the same artifact — the installed apps
  update from it. Before that publish, read the artifact once
  (`action: "read"`, the same `url`), as the tool requires. Do not pass
  `icon`. Pass `capabilities` as given (`{"desktop": {}}`).
- **It does not exist** (first publish): omit `url`, pass `capabilities`
  and `icon` as given. Write the returned artifact URL to `artifact.json`
  as `{"url": "<the url>"}` and commit that file, so the next run updates
  this artifact instead of creating another.

If the publish is refused for a conflict (someone published in between),
read the artifact again and publish again; never pass `force`.

## 4. Tell the user

In a few lines:

- the artifact's link, and that this was a first publish or a new version
  (with the commit from `publish.json` → `build.commit`);
- how to install: open the link **in the Claude desktop app** → the
  artifact's menu → **Install as app**. An installed app picks a new
  version up by itself; it asks for access again once per new version;
- the first run asks for the **workspace folder** (a checkout of this
  repository, with `npm install` done) and needs `python3`, `node` and the
  `claude` CLI on that computer;
- anything that failed or was skipped.

Sharing the artifact with other people, or making it public, is not part of
this step and not something this tool can do: say so if asked. `full-access`
is only granted on an artifact of the person's own organization.

## What cannot be checked here

The desktop API exists only inside the installed app, so nothing in this
repository can run it. `test/desktop.test.mjs` covers the bridge to the
engine and what the build ships; the installed app's own behaviour (its
permission dialogs, its frame's restrictions) has to be tried by installing
it. If the user reports a problem there, the setup screen's detail text and
the app's console are where the cause shows.
