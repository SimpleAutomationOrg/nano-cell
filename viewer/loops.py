"""Read and rewrite the step lists of an application's loops.ts.

The file is TypeScript written by hand; the viewer's step list shows its
loops and, when a step is dragged, saves the new order back. Only the
contents of a loop's `steps: [...]` list are ever rewritten — the rest of
the file, comments included, stays byte for byte.

    'assemble-case': {
      name: 'Assemble one case',
      steps: [
        'pick-place-case',
      ],
    },
"""
import re

_LOOP = re.compile(
    r"""^(?P<ind>[ \t]+)(?P<q>['"])(?P<id>[\w-]+)(?P=q):\s*\{   # 'id': {
        (?P<body>.*?)
        ^(?P=ind)\}""", re.M | re.S | re.X)
_NAME = re.compile(r"""\bname:\s*(['"])(.*?)\1""")
_STEPS = re.compile(r"\bsteps:\s*\[(.*?)\]", re.S)
_ITEM = re.compile(r"""(['"])([\w-]+)\1""")
_COMMENT = re.compile(r"//.*$", re.M)


def parse(src):
    """[{id, name, steps}] in file order."""
    loops = []
    for m in _LOOP.finditer(src):
        body = m.group("body")
        steps = _STEPS.search(body)
        if not steps:
            continue
        name = _NAME.search(body)
        loops.append({
            "id": m.group("id"),
            "name": name.group(2) if name else m.group("id"),
            "steps": [i.group(2) for i in _ITEM.finditer(_COMMENT.sub("", steps.group(1)))],
        })
    return loops


def with_steps(src, loop_id, steps):
    """`src` with the steps of loop `loop_id` replaced; None if there is no such loop."""
    for m in _LOOP.finditer(src):
        if m.group("id") != loop_id:
            continue
        s = _STEPS.search(m.group("body"))
        if not s:
            return None
        ind = m.group("ind") * 3
        inner = "".join(f"\n{ind}'{x}'," for x in steps) + ("\n" + m.group("ind") * 2 if steps else "")
        a = m.start("body") + s.start(1)
        b = m.start("body") + s.end(1)
        return src[:a] + inner + src[b:]
    return None
