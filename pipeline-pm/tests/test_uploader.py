#!/usr/bin/env python3
"""pick_uploader 的單元測試（不打網路）。

執行：python3 pipeline-pm/tests/test_uploader.py

背景（2026-09-01）：PM 錄製完成通知長期顯示「錄製者：unknown」——metadata.json
從來沒有 recorder 欄位（30/30 session 實查皆無，因為 .pm-config.json 沒被建立）。
補救是退回問 Drive「這個 session 資料夾是誰上傳的」。共用雲端硬碟的 owners 是空的，
真正有值的是 lastModifyingUser，這裡把該優先序釘死。
"""
import importlib.util
import os
import sys
import unittest

_GDRIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "vox-pm-gdrive.py")
_spec = importlib.util.spec_from_file_location("vox_pm_gdrive", _GDRIVE)
gdrive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gdrive)


class PickUploaderTest(unittest.TestCase):
    def test_uses_last_modifying_user(self):
        # 實測 VoxTrace-PM Shared Drive 回的就是這個形狀：owners 缺席、只有 lastModifyingUser
        meta = {"id": "x", "name": "debug-1",
                "lastModifyingUser": {"displayName": "davidhsieh"}}
        self.assertEqual(gdrive.pick_uploader(meta), "davidhsieh")

    def test_falls_back_to_email_when_no_display_name(self):
        meta = {"lastModifyingUser": {"emailAddress": "pearl@example.com"}}
        self.assertEqual(gdrive.pick_uploader(meta), "pearl@example.com")

    def test_falls_back_to_owners(self):
        meta = {"owners": [{"displayName": "Pearl"}]}
        self.assertEqual(gdrive.pick_uploader(meta), "Pearl")

    def test_last_modifying_user_wins_over_owners(self):
        meta = {"lastModifyingUser": {"displayName": "Pearl"},
                "owners": [{"displayName": "服務帳號"}]}
        self.assertEqual(gdrive.pick_uploader(meta), "Pearl")

    def test_returns_empty_when_nothing_known(self):
        self.assertEqual(gdrive.pick_uploader({}), "")
        self.assertEqual(gdrive.pick_uploader({"owners": [], "lastModifyingUser": {}}), "")

    def test_ignores_blank_display_name(self):
        meta = {"lastModifyingUser": {"displayName": "   "},
                "owners": [{"displayName": "Pearl"}]}
        self.assertEqual(gdrive.pick_uploader(meta), "Pearl")


if __name__ == "__main__":
    unittest.main(verbosity=2)
