#!/usr/bin/env python3
"""Optimize Still Has Value shop product photos before commit/deploy.

Google Photos / phone originals are often 3024–4032px and multi-MB.
Shop cards display ~400px wide; detail views rarely need more than ~1600px.

Usage:
  python3 scripts/optimize-shop-images.py images/shv-xxx/0.jpg
  python3 scripts/optimize-shop-images.py images/          # recurse
  python3 scripts/optimize-shop-images.py --check images/  # exit 1 if any too large

Defaults: max long edge 1600px, JPEG quality 80, progressive, strip EXIF
(except orientation). Rewrites in place when savings > 2% or dimensions drop.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageOps

MAX_EDGE = 1600
JPEG_QUALITY = 80
# Fail --check if any file exceeds either limit (guards future uploads)
CHECK_MAX_BYTES = 500_000  # ~450 KB
CHECK_MAX_EDGE = 1600


def optimize_one(path: Path, max_edge: int, quality: int, dry_run: bool) -> tuple[int, int, str]:
    before = path.stat().st_size
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        w, h = im.size
        long_edge = max(w, h)
        scale = 1.0
        if long_edge > max_edge:
            scale = max_edge / float(long_edge)
            nw = max(1, int(round(w * scale)))
            nh = max(1, int(round(h * scale)))
            im = im.resize((nw, nh), Image.Resampling.LANCZOS)
            w, h = nw, nh
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        elif im.mode == "L":
            im = im.convert("RGB")

        if dry_run:
            return before, before, f"{path}: would be {w}x{h} (dry-run)"

        tmp = path.with_suffix(path.suffix + ".tmp")
        save_kw = dict(quality=quality, optimize=True, progressive=True)
        # Keep ICC if present for color accuracy on product photos
        icc = im.info.get("icc_profile")
        if icc:
            save_kw["icc_profile"] = icc
        im.save(tmp, format="JPEG", **save_kw)
        after = tmp.stat().st_size
        # Only replace if smaller or we resized
        if after < before * 0.98 or scale < 1.0:
            tmp.replace(path)
            return before, after, f"{path}: {before/1024:.0f}KB → {after/1024:.0f}KB ({w}x{h})"
        tmp.unlink(missing_ok=True)
        return before, before, f"{path}: kept ({before/1024:.0f}KB, {w}x{h})"


def check_one(path: Path) -> str | None:
    sz = path.stat().st_size
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        w, h = im.size
    long_edge = max(w, h)
    problems = []
    if sz > CHECK_MAX_BYTES:
        problems.append(f"{sz/1024:.0f}KB > {CHECK_MAX_BYTES/1024:.0f}KB")
    if long_edge > CHECK_MAX_EDGE:
        problems.append(f"{long_edge}px > {CHECK_MAX_EDGE}px")
    if problems:
        return f"{path}: " + ", ".join(problems)
    return None


def iter_jpgs(paths: list[Path]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        if p.is_dir():
            out.extend(sorted(p.rglob("*.jpg")))
            out.extend(sorted(p.rglob("*.jpeg")))
            out.extend(sorted(p.rglob("*.JPG")))
            out.extend(sorted(p.rglob("*.JPEG")))
        elif p.is_file():
            out.append(p)
    # de-dupe preserving order
    seen = set()
    uniq = []
    for p in out:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            uniq.append(p)
    return uniq


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--max-edge", type=int, default=MAX_EDGE)
    ap.add_argument("--quality", type=int, default=JPEG_QUALITY)
    ap.add_argument("--check", action="store_true", help="Validate only; exit 1 if oversized")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files = iter_jpgs(args.paths)
    if not files:
        print("No JPEG files found.", file=sys.stderr)
        return 2

    if args.check:
        bad = [check_one(p) for p in files]
        bad = [b for b in bad if b]
        for b in bad:
            print(b, file=sys.stderr)
        if bad:
            print(
                f"\n{len(bad)} file(s) exceed limits. Run:\n"
                f"  python3 scripts/optimize-shop-images.py {' '.join(str(p) for p in args.paths)}",
                file=sys.stderr,
            )
            return 1
        print(f"OK: {len(files)} image(s) within {CHECK_MAX_EDGE}px / {CHECK_MAX_BYTES/1024:.0f}KB")
        return 0

    total_before = total_after = 0
    for p in files:
        b, a, msg = optimize_one(p, args.max_edge, args.quality, args.dry_run)
        total_before += b
        total_after += a
        print(msg)
    saved = total_before - total_after
    print(
        f"\nDone: {len(files)} files, "
        f"{total_before/1024/1024:.1f}MB → {total_after/1024/1024:.1f}MB "
        f"(saved {saved/1024/1024:.1f}MB)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
