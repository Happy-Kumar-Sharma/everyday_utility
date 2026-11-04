"""Will git pick this file up? Asked of git itself (anchoring, negation, nested .gitignore files), also for
folders that are not `git init`-ed yet (the app folder before its first commit), via a throwaway git dir."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path


def git_root(path: Path) -> Path | None:
    for d in [path.parent, *path.parent.parents]:
        if (d / ".git").exists():
            return d
    return None


def git_ignored(work_tree: Path, rel: str, git_dir: Path | None = None) -> bool:
    cmd = ["git"]
    if git_dir is not None:
        cmd += [f"--git-dir={git_dir}", f"--work-tree={work_tree}"]
    else:
        cmd += ["-C", str(work_tree)]
    res = subprocess.run(cmd + ["check-ignore", "-q", "--no-index", rel], capture_output=True, text=True, cwd=work_tree)
    return res.returncode == 0  # 1 = not ignored, 128 = error: both treated as NOT safe


def git_tracked(root: Path, rel: str) -> bool:
    return subprocess.run(["git", "-C", str(root), "ls-files", "--error-unmatch", rel],
                          capture_output=True, text=True).returncode == 0


def path_safety(path: Path, app_root: Path) -> dict:
    """{in_repo, repo, rel, ignored, tracked, safe} for one path (it does not need to exist)."""
    path, app_root = path.resolve(), app_root.resolve()
    root = git_root(path)
    if root is not None:
        rel = path.relative_to(root).as_posix()
        ignored = git_ignored(root, rel)
        tracked = git_tracked(root, rel)
        return {"in_repo": True, "repo": str(root), "rel": rel, "ignored": ignored, "tracked": tracked,
                "safe": ignored and not tracked}
    try:
        rel = path.relative_to(app_root).as_posix()
    except ValueError:
        return {"in_repo": False, "safe": True}
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["git", "init", "-q", "--bare", tmp], capture_output=True, check=False)
        ignored = git_ignored(app_root, rel, Path(tmp))
    return {"in_repo": True, "repo": str(app_root), "rel": rel, "ignored": ignored, "tracked": False, "safe": ignored}


def all_safe(paths: list[Path], app_root: Path) -> dict:
    """Safety of the first path, with `safe` true only if every path is safe."""
    checks = [path_safety(p, app_root) for p in paths]
    main = checks[0]
    main["safe"] = all(c["safe"] for c in checks)
    return main


def dir_safety(folder: Path, app_root: Path) -> dict:
    """Would git commit anything written anywhere under `folder`? Safe only if git ignores the folder for any
    file name (probes with odd names/extensions, the trash, metadata) and tracks nothing in it already."""
    folder = folder.resolve()
    probes = [folder / "__eu_probe__", folder / "__eu_probe__.zz9", folder / "Collection" / "__eu_probe__.sh",
              folder / ".trash" / "__eu_probe__", folder / ".library.json"]
    main = all_safe(probes, app_root)
    root = git_root(folder / "x")
    if root is not None:
        rel = folder.relative_to(root).as_posix()
        tracked = subprocess.run(["git", "-C", str(root), "ls-files", "--", rel], capture_output=True, text=True).stdout.strip()
        if tracked:
            main.update(safe=False, tracked=True)
    return main
