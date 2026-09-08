#!/usr/bin/env python3
"""test_ship_select — vox-pm-gdrive.py 的純邏輯 select_ship_files 單元測試。

只測「從 SHIP 清單挑出目錄實際存在的檔案」——不碰 Google API（那部分需憑證，
無法本機純測，另在交付說明標註）。執行： python3 test_ship_select.py
"""
import importlib.util
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE.parent / "vox-pm-gdrive.py"

spec = importlib.util.spec_from_file_location("vox_pm_gdrive", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

PASS = 0
FAIL = 0


def check(desc, cond):
    global PASS, FAIL
    if cond:
        print(f"  ✓ {desc}")
        PASS += 1
    else:
        print(f"  ✗ {desc}")
        FAIL += 1


def main() -> int:
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)

        # 空目錄 → 空清單
        check("空目錄回空清單", mod.select_ship_files(dp) == [])

        # 只放部分檔案 → 只挑存在的，且保持 SHIP_FILES 順序
        (dp / "metadata.json").write_text("{}")
        (dp / "video.webm").write_text("x")
        (dp / "unrelated.txt").write_text("x")  # 不在清單不挑
        got = mod.select_ship_files(dp)
        check("只挑存在且在清單內的檔案", got == ["video.webm", "metadata.json"])
        check("不挑清單外檔案", "unrelated.txt" not in got)

        # 目錄名（含子目錄）不挑
        (dp / "keyframes").mkdir()
        got2 = mod.select_ship_files(dp)
        check("子目錄不入清單", "keyframes" not in got2)

        # 全檔齊全 → 順序完全等於 SHIP_FILES
        for name in mod.SHIP_FILES:
            (dp / name).write_text("x")
        check("全齊時順序等於 SHIP_FILES", mod.select_ship_files(dp) == mod.SHIP_FILES)

    # 多 tab 錄製：Playwright 只把其中一支 rename 成 video.webm，其餘留 page@<hash>.webm。
    # 一次錄製的每個 tab 影片都要上傳，不能只傳 video.webm。
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        (dp / "metadata.json").write_text("{}")
        (dp / "video.webm").write_text("x")
        (dp / "page@b43cfd80.webm").write_text("x")
        (dp / "page@8aaa5420.webm").write_text("x")
        (dp / "page@eae556de.webm").write_text("x")
        (dp / "page@notavideo.txt").write_text("x")  # 非 .webm 不挑

        got = mod.select_ship_files(dp)
        check("多 tab：每支 page@*.webm 都入清單",
              all(f"page@{h}.webm" in got for h in ("b43cfd80", "8aaa5420", "eae556de")))
        check("多 tab：video.webm 仍在清單", "video.webm" in got)
        check("多 tab：非 .webm 的 page@ 檔不挑", "page@notavideo.txt" not in got)
        check("多 tab：page@*.webm 依字典序穩定排列",
              [n for n in got if n.startswith("page@")]
              == ["page@8aaa5420.webm", "page@b43cfd80.webm", "page@eae556de.webm"])
        check("多 tab：固定清單排在 page@*.webm 之前",
              got.index("metadata.json") < got.index("page@8aaa5420.webm"))
        check("多 tab：無重複項", len(got) == len(set(got)))

    print(f"\nResult: {PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
