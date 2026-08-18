#!/usr/bin/env python3
"""test_network_error — vox-pm-gdrive.py 的 _is_network_error 純邏輯單元測試。

重點：httplib2 DNS 失敗丟 ServerNotFoundError（訊息 "Unable to find the
server at ..."），必須被判為可重試網路錯誤（→ exit 75 pending），否則該丟的
session 會被標 failed 永不重試而永久丟資料。不 import httplib2，用假物件模擬。
執行： python3 test_network_error.py
"""
import importlib.util
import sys
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


# 模擬 httplib2.ServerNotFoundError（不 import httplib2 避免硬依賴）。
class ServerNotFoundError(Exception):
    pass


def main() -> int:
    snf = ServerNotFoundError("Unable to find the server at www.googleapis.com")
    check("ServerNotFoundError（類名比對）判為網路錯誤", mod._is_network_error(snf) is True)

    # 訊息關鍵字命中（即使類名不同也該中）。
    generic = Exception("Unable to find the server at example.com")
    check("訊息含 'unable to find the server' 判為網路錯誤",
          mod._is_network_error(generic) is True)

    # 一般 ValueError 不是網路錯誤（不可重試）。
    check("一般 ValueError 非網路錯誤", mod._is_network_error(ValueError("bad arg")) is False)

    # timeout 關鍵字仍維持原判定。
    check("timeout 關鍵字仍判網路錯誤",
          mod._is_network_error(Exception("operation timed out")) is True)

    print(f"\nResult: {PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
