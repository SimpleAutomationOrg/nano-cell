"""Runs of steps asked for from outside the page.

The agent cannot see or drive the viewer, but it can ask for a run:
`node scripts/run-step.mjs` posts a request here, the open viewer of that
application takes it, runs the steps in the real simulation — the user
watches it happen — and posts back what came of it. This module is the
hand-over between the two: a request waits until a page takes it and
answers, or until its time is up.

One job at a time per application. A page that takes a job keeps saying
so while it works on it (`alive`); a job nobody is vouching for — the
page was reloaded under it, or the answer that carried it went to a
connection the browser had already dropped — is given out again.
"""
import threading
import time
import uuid

LISTEN_FOR = 40          # a page that asked within this many seconds is "open"
VOUCH_FOR = 8            # a job is its taker's for this long after the taker last said so


class Runs:
    def __init__(self):
        self.cond = threading.Condition()
        self.jobs = {}       # application -> the job waiting or running
        self.seen = {}       # application -> when a page last asked for work

    def request(self, app, job, timeout=300):
        """Ask the open viewer of `app` to do `job`; returns its result (a dict)."""
        me = {"id": uuid.uuid4().hex, "job": job, "page": None, "alive": 0.0, "result": None}
        end = time.time() + timeout
        with self.cond:
            if app in self.jobs:
                return {"ok": False, "error": "another run was asked for and has not finished"}
            self.jobs[app] = me
            self.cond.notify_all()
            try:
                while me["result"] is None:
                    now = time.time()
                    if me["page"] is None and now - self.seen.get(app, 0) > LISTEN_FOR and now > end - timeout + 8:
                        return {"ok": False, "error":
                                f"the application '{app}' is not open in the viewer (or its window is hidden): "
                                "ask the user to open it and keep it on screen"}
                    if now >= end:
                        return {"ok": False, "error": f"no result within {timeout} s — the run may still be going in the viewer"}
                    self.cond.wait(timeout=min(2, end - now))
                return me["result"]
            finally:
                if self.jobs.get(app) is me:
                    del self.jobs[app]

    def next(self, app, page, timeout=25):
        """For the page: the job to do now, or None. `page` names this load of the page."""
        end = time.time() + timeout
        with self.cond:
            while True:
                self.seen[app] = time.time()
                j = self.jobs.get(app)
                if j and j["result"] is None and time.time() - j["alive"] > VOUCH_FOR:
                    j["page"], j["alive"] = page, time.time()
                    self.cond.notify_all()
                    return {"id": j["id"], **j["job"]}
                left = end - time.time()
                if left <= 0:
                    return None
                self.cond.wait(timeout=min(5, left))

    def alive(self, job_id, page):
        """The page that took the job is still working on it."""
        with self.cond:
            for j in self.jobs.values():
                if j["id"] == job_id and j["page"] == page and j["result"] is None:
                    j["alive"] = time.time()
                    return True
        return False

    def result(self, job_id, data):
        with self.cond:
            for j in self.jobs.values():
                if j["id"] == job_id and j["result"] is None:
                    j["result"] = data
                    self.cond.notify_all()
                    return True
        return False
