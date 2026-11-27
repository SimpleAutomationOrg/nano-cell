"""Read and rewrite the step list of an application's loop.ts.

The file is TypeScript written by hand; the viewer's step list shows the
loop and, when a step is dragged, saves the new order back. Only the
contents of the `steps: [...]` list are ever rewritten — the rest of the
file, comments included, stays byte for byte.

    export const loop: Loop = {
      name: 'Assemble one case',
      steps: [
        'pick-place-case',
      ],
    };
"""
import re

_LOOP = re.compile(r"^export const loop\b[^=]*=\s*\{(?P<body>.*?)^\};?", re.M | re.S)
_NAME = re.compile(r"""\bname:\s*(['"])(.*?)\1""")
_STEPS = re.compile(r"\bsteps:\s*\[(.*?)\]", re.S)
_ITEM = re.compile(r"""(['"])([\w-]+)\1""")
_COMMENT = re.compile(r"//.*$", re.M)


def _find(src):
    m = _LOOP.search(src)
    s = m and _STEPS.search(m.group("body"))
    return (m, s) if s else (None, None)


def parse(src):
    """{name, steps}, or None when the file declares no loop."""
    m, s = _find(src)
    if not m:
        return None
    name = _NAME.search(m.group("body"))
    return {"name": name.group(2) if name else "loop",
            "steps": [i.group(2) for i in _ITEM.finditer(_COMMENT.sub("", s.group(1)))]}


def with_steps(src, steps):
    """`src` with the loop's steps replaced; None when it declares no loop."""
    m, s = _find(src)
    if not m:
        return None
    inner = "".join(f"\n    '{x}'," for x in steps) + ("\n  " if steps else "")
    a = m.start("body") + s.start(1)
    b = m.start("body") + s.end(1)
    return src[:a] + inner + src[b:]
