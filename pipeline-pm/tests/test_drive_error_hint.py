#!/usr/bin/env python3
"""Shared Drive 存取錯誤的可行動訊息測試（純字串，不打網路）。

執行：python3 pipeline-pm/tests/test_drive_error_hint.py

背景（2026-09-07，Grace 安裝實錄「坑 5」）：`auth` 失敗時原本直接把 google
的 HttpError 原文丟出來，使用者看到一串 403 完全不知道要做什麼——實際上
答案很固定：這個 Google 帳號還不是共用碟成員，要請開發團隊加人。
把「該找誰、要說什麼、用哪個信箱」直接印在錯誤裡，才不用每次都由旁邊的人翻譯。

特別注意：Drive 對「不是成員」會回兩種不同代碼（teamDriveMembershipRequired
與 insufficientFilePermissions），driveId 打錯則是 404 notFound——三者的處置
不同（前兩者要加人、後者要改 ID），訊息不能混為一談。
"""
import importlib.util
import os
import unittest

_GDRIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "vox-pm-gdrive.py")
_spec = importlib.util.spec_from_file_location("vox_pm_gdrive", _GDRIVE)
gdrive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gdrive)

DRIVE = "0AARcpNp_0suwUk9PVA"
WHO = "teammate@example.com"

MEMBERSHIP_403 = (
    "<HttpError 403 when requesting https://www.googleapis.com/drive/v3/files?"
    "driveId=0AARcpNp_0suwUk9PVA&corpora=drive returned "
    '"The attempted action requires shared drive membership.". '
    "Details: \"[{'message': 'The attempted action requires shared drive membership.', "
    "'domain': 'global', 'reason': 'teamDriveMembershipRequired'}]\">"
)
INSUFFICIENT_403 = (
    "<HttpError 403 ... returned \"The user does not have sufficient permissions "
    "for this file.\". Details: \"[{'reason': 'insufficientFilePermissions'}]\">"
)
NOT_FOUND_404 = (
    "<HttpError 404 ... returned \"Shared drive not found: 0ABogusDriveId\". "
    "Details: \"[{'reason': 'notFound'}]\">"
)


class DriveErrorHintTest(unittest.TestCase):
    def test_membership_error_says_add_as_member(self):
        msg = gdrive.explain_drive_error(MEMBERSHIP_403, DRIVE, WHO)
        self.assertIn("成員", msg)
        self.assertIn(DRIVE, msg)
        self.assertIn(WHO, msg)

    def test_membership_error_warns_folder_share_is_not_enough(self):
        # 這是最常被搞錯的一點：把資料夾「分享」給你 ≠ 加入共用碟成員，
        # corpora=drive 查詢一樣 403（Grace 實錄與 Slack 對話都點名這條）
        msg = gdrive.explain_drive_error(MEMBERSHIP_403, DRIVE, WHO)
        self.assertIn("資料夾", msg)

    def test_membership_error_states_required_role(self):
        # 「檢視者」不能上傳，要 Contributor 以上
        msg = gdrive.explain_drive_error(MEMBERSHIP_403, DRIVE, WHO)
        self.assertIn("Contributor", msg)

    def test_insufficient_permissions_treated_as_membership_problem(self):
        msg = gdrive.explain_drive_error(INSUFFICIENT_403, DRIVE, WHO)
        self.assertIn("成員", msg)
        self.assertIn(WHO, msg)

    def test_not_found_points_at_drive_id_not_membership(self):
        msg = gdrive.explain_drive_error(NOT_FOUND_404, DRIVE, WHO)
        self.assertIn("VOX_PM_DRIVE_ID", msg)
        # 404 是 ID 打錯，不該叫人去要權限
        self.assertNotIn("Contributor", msg)

    def test_invalid_grant_tells_user_to_reauthorize(self):
        msg = gdrive.explain_drive_error("invalid_grant: Token has been expired or revoked.",
                                         DRIVE, WHO)
        self.assertIn("vox-pm-auth.py", msg)

    def test_unknown_error_keeps_original_text(self):
        raw = "<HttpError 500 ... backendError>"
        msg = gdrive.explain_drive_error(raw, DRIVE, WHO)
        self.assertIn(raw, msg)

    def test_original_text_always_retained(self):
        # 翻譯不能把原文吃掉——排查時仍需要原始 HttpError
        for raw in (MEMBERSHIP_403, INSUFFICIENT_403, NOT_FOUND_404):
            self.assertIn(raw, gdrive.explain_drive_error(raw, DRIVE, WHO))

    # ── 分類不可過寬：把不相干的錯誤判成「driveId 打錯」會把人帶去改設定 ──

    def test_file_level_not_found_is_not_treated_as_drive_id_error(self):
        # 檔案級 404（fileId 不存在）跟共用碟無關。接進 upload/download 後這條立刻可達。
        msg = gdrive.explain_drive_error(
            '<HttpError 404 ... returned "File not found: 1abcXYZ.". '
            "Details: \"[{'reason': 'notFound'}]\">", DRIVE, WHO)
        self.assertNotIn("VOX_PM_DRIVE_ID", msg)

    def test_missing_credential_file_is_not_treated_as_drive_id_error(self):
        msg = gdrive.explain_drive_error(
            "File /Users/g/.config/vox-pm/service-account.json was not found.", DRIVE, WHO)
        self.assertNotIn("VOX_PM_DRIVE_ID", msg)

    def test_invalid_grant_wins_over_not_found(self):
        # 「invalid_grant: Account not found」同時含兩個關鍵字，
        # 特異度高的 invalid_grant 要贏——否則會叫人去改 driveId
        msg = gdrive.explain_drive_error(
            "invalid_grant: Account not found.", DRIVE, WHO)
        self.assertIn("vox-pm-auth.py", msg)
        self.assertNotIn("VOX_PM_DRIVE_ID", msg)

    def test_proxy_html_404_is_passed_through(self):
        raw = "<html>404 Not Found - nginx</html>"
        self.assertEqual(gdrive.explain_drive_error(raw, DRIVE, WHO), raw)

    def test_works_without_known_email(self):
        # 拿不到信箱時（about() 也失敗）不能崩，也不能印出空白的「請把  加入」
        msg = gdrive.explain_drive_error(MEMBERSHIP_403, DRIVE, "")
        self.assertIn("成員", msg)
        self.assertNotIn("將  加入", msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
