"""
Build one self-contained HTML file from web/ (index.html + style.css + js/ modules + vendor/*.js).

    python scripts/build_single.py            -> dist/lumilyric.html

The single file opens by double-clicking (no local helper needed for playback and export), and is the version
used for the online copy of the page. Only the Python standard library is used.

The page's own code is a tree of ES modules (js/app.js imports the others). A file opened from disk cannot load
modules, so they are put into one plain script here: in the order a browser would run them (depth first, imports in the
order written), with the import lines and the export lists removed. That is sound because every top-level name of
the modules is unique across the page (the page used to be one global scope, and the build checks it again).
"""
import base64
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")

IMPORT_LINE = re.compile(r"""^import\s+(?:[^'";\n]*?\s+from\s+)?['"]([^'"]+)['"];?[ \t]*\n?""", re.M)
EXPORT_LIST = re.compile(r"^export\s*\{[^}]*\};?[ \t]*\n?", re.M)
EXPORT_DECL = re.compile(r"^export\s+(?=(?:const|let|var|function|class|async)\b)", re.M)
TOP_NAME = re.compile(r"^(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)", re.M)


def read(rel):
    with open(os.path.join(WEB, rel), encoding="utf-8") as f:
        return f.read()


def module_order(entry):
    """The module files in the order the browser runs them, from the entry module."""
    order, seen = [], set()

    def visit(rel):
        if rel in seen:
            return
        seen.add(rel)
        base = os.path.dirname(rel)
        for m in IMPORT_LINE.finditer(read(rel)):
            visit(os.path.normpath(os.path.join(base, m.group(1))).replace("\\", "/"))
        order.append(rel)

    visit(entry)
    return order


def bundle(entry):
    names = {}
    parts = []
    for rel in module_order(entry):
        src = read(rel)
        for m in TOP_NAME.finditer(src):
            if m.group(1) in names:
                raise SystemExit(f"{rel}: top-level name {m.group(1)} is also declared in {names[m.group(1)]}; "
                                 "the single-file build puts all modules in one scope, so names must be unique")
            names[m.group(1)] = rel
        src = EXPORT_LIST.sub("", IMPORT_LINE.sub("", src))
        src = EXPORT_DECL.sub("", src)
        parts.append(f"/* ---- {rel} ---- */\n" + src.strip("\n"))
    return "'use strict';\n" + "\n\n".join(parts)


def stylesheet(m):
    """<link rel="stylesheet" href="x.css"> -> <style>…</style>.
    fonts/fonts-latin.css: with its small font files inside as data: URIs (Archivo, JetBrains Mono; about 150 KB).
    fonts/fonts-cjk.css: left out, Noto Sans SC is 7 MB; Chinese text then uses the system's own Chinese font, which the
    font stacks already list after Noto Sans SC."""
    href = m.group(1)
    if href.endswith("fonts-cjk.css"):
        return ""
    css = read(href)
    if href.endswith("fonts-latin.css"):
        base = os.path.dirname(href)

        def data_uri(u):
            with open(os.path.join(WEB, base, u.group(1)), "rb") as f:
                return "url(data:font/woff2;base64," + base64.b64encode(f.read()).decode("ascii") + ")"
        css = re.sub(r"url\(\./([^)]+\.woff2)\)", data_uri, css)
    return "<style>\n" + css.rstrip("\n") + "\n</style>\n"


def build():
    html = read("index.html")
    html = re.sub(r'<link rel="stylesheet" href="(?!https?:)([^"]+)">\n?', stylesheet, html)
    # <script src="vendor/x.js"></script>  ->  inline; "</script" inside the code is escaped so it cannot end the tag
    html = re.sub(r'<script src="(?!https?:)([^"]+)"></script>',
                  lambda m: "<script>/* " + m.group(1) + " */\n" +
                            read(m.group(1)).replace("</script", "<\/script").rstrip("\n") + "\n</script>", html)
    # <script type="module" src="js/app.js"></script>  ->  all the modules as one plain script
    html = re.sub(r'<script type="module" src="(?!https?:)([^"]+)"></script>',
                  lambda m: "<script>\n" + bundle(m.group(1)).replace("</script", "<\/script") + "\n</script>", html)
    return html


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist", "lumilyric.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    html = build()
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print(f"written {out} ({len(html.encode('utf-8')) // 1024} KB)")


if __name__ == "__main__":
    main()
