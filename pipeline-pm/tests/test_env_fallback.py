#!/usr/bin/env python3
"""drive_id() 的 env 檔後備讀取測試（不打網路）。

執行：python3 pipeline-pm/tests/test_env_fallback.py

背景（2026-09-07，Grace 安裝實錄「坑 4」）：使用者 `cat ~/.config/vox-pm/env`
看得到 VOX_PM_DRIVE_ID，手動跑 `vox-pm-gdrive.py auth` 卻說「缺少」——因為 cat
不會把 export 載進當前 shell，而 drive_id() 只讀 os.environ。
背景 worker 一直是好的（vox-pm-queue-worker.sh 自己有 source 那個檔），
只有手動執行會中招，所以這個坑很難被開發端看見。

這裡把後備讀取的語意釘死，特別是**註解行陷阱**：實際的 env 檔裡有一行
「# 舊值（保留備查）：export VOX_PM_DRIVE_ID=<已停用的舊碟>」——天真的
子字串比對會撈到舊碟 ID，然後把錄影**靜默上傳到已停用的碟**。
這種錯不會報錯，只會讓檔案消失在沒人看的地方，所以必須有回歸測試。
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

_GDRIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "vox-pm-gdrive.py")
_spec = importlib.util.spec_from_file_location("vox_pm_gdrive", _GDRIVE)
gdrive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gdrive)

NEW_ID = "0AARcpNp_0suwUk9PVA"
OLD_ID = "0AOldDeadDriveXXXXX"


class DriveIdEnvFallbackTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self._tmp.name)
        self._saved = {k: os.environ.get(k)
                       for k in ("VOX_PM_DRIVE_ID", "VOX_PM_CONFIG_DIR")}
        os.environ["VOX_PM_CONFIG_DIR"] = str(self.cfg)
        os.environ.pop("VOX_PM_DRIVE_ID", None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _write_env(self, text):
        (self.cfg / "env").write_text(text, encoding="utf-8")

    def test_environ_wins_when_set(self):
        os.environ["VOX_PM_DRIVE_ID"] = NEW_ID
        self._write_env(f"export VOX_PM_DRIVE_ID={OLD_ID}\n")
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    def test_falls_back_to_env_file(self):
        self._write_env(f"export VOX_PM_DRIVE_ID={NEW_ID}\n")
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    def test_reads_assignment_without_export(self):
        self._write_env(f"VOX_PM_DRIVE_ID={NEW_ID}\n")
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    def test_ignores_commented_out_old_value(self):
        # 這是本機 env 檔的真實形狀——註解裡留著已停用的舊碟 ID 備查
        self._write_env(
            "# 2026-08-18 遷移：舊碟停用 → 換到 VoxTrace-PM\n"
            f"# 舊值（保留備查）：export VOX_PM_DRIVE_ID={OLD_ID}\n"
            f"export VOX_PM_DRIVE_ID={NEW_ID}\n"
        )
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    def test_commented_value_alone_is_not_used(self):
        self._write_env(f"# export VOX_PM_DRIVE_ID={OLD_ID}\n")
        self.assertEqual(gdrive.drive_id(), "")

    def test_last_assignment_wins(self):
        # shell 語意：後面的 export 蓋掉前面的
        self._write_env(
            f"export VOX_PM_DRIVE_ID={OLD_ID}\n"
            f"export VOX_PM_DRIVE_ID={NEW_ID}\n"
        )
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    def test_strips_quotes_and_spaces(self):
        self._write_env(f'export VOX_PM_DRIVE_ID = "{NEW_ID}"  \n')
        self.assertEqual(gdrive.drive_id(), NEW_ID)
        self._write_env(f"export VOX_PM_DRIVE_ID='{NEW_ID}'\n")
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    def test_ignores_trailing_inline_comment(self):
        self._write_env(f"export VOX_PM_DRIVE_ID={NEW_ID}   # 正式碟\n")
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    def test_ignores_other_keys(self):
        self._write_env(
            "export VOX_SLACK_CHANNEL=C123\n"
            "export VOX_PM_DRIVE_ID_OLD=nope\n"
        )
        self.assertEqual(gdrive.drive_id(), "")

    def test_missing_file_returns_empty(self):
        self.assertEqual(gdrive.drive_id(), "")

    def test_undecodable_file_returns_empty(self):
        # 權限/編碼壞掉時要安靜回空字串，不能讓整支腳本炸掉。
        # （斷言必須是 ==""，不能只斷言 isinstance(str)——那條永遠會過，
        #   連「回傳死碟 ID」都會過，等於沒有守門。）
        (self.cfg / "env").write_bytes(b"\xff\xfe\x00 export VOX_PM_DRIVE_ID=x\n")
        self.assertEqual(gdrive.drive_id(), "")

    def test_unreadable_file_returns_empty(self):
        p = self.cfg / "env"
        p.write_text(f"export VOX_PM_DRIVE_ID={NEW_ID}\n", encoding="utf-8")
        p.chmod(0o000)
        try:
            self.assertEqual(gdrive.drive_id(), "")
        finally:
            p.chmod(0o600)

    # ── 以下釘死「靜默上傳到死碟」的各種變體 ──────────────────
    #
    # 註解陷阱只是「停用一行 shell」的其中一種寫法。解析器看不見 shell 控制流，
    # 於是 `if ...; then export <舊碟>; fi` 這種**shell 根本不會執行**的賦值會被
    # 當成最後一個生效值——source 得到正式碟、本程式得到死碟，零徵兆。
    #
    # 注意：形狀驗證擋不住這個，因為死碟 ID 的形狀完全合法。
    # 唯一安全的做法是：檔案一旦含 shell 控制流，就不猜了、退回要求 source。

    def test_control_flow_guarded_assignment_is_not_trusted(self):
        self._write_env(
            f"export VOX_PM_DRIVE_ID={NEW_ID}   # 正式碟\n"
            'if [ -n "$VOX_PM_DEV" ]; then\n'
            f"  export VOX_PM_DRIVE_ID={OLD_ID}  # 開發碟\n"
            "fi\n"
        )
        # 絕對不可以回死碟。回正式碟或回空字串都算安全（空字串＝大聲說缺少）
        self.assertNotEqual(gdrive.drive_id(), OLD_ID)

    def test_case_block_assignment_is_not_trusted(self):
        self._write_env(
            f"export VOX_PM_DRIVE_ID={NEW_ID}\n"
            'case "$MODE" in\n'
            f"  dev) export VOX_PM_DRIVE_ID={OLD_ID} ;;\n"
            "esac\n"
        )
        self.assertNotEqual(gdrive.drive_id(), OLD_ID)

    def test_function_body_assignment_is_not_trusted(self):
        self._write_env(
            f"export VOX_PM_DRIVE_ID={NEW_ID}\n"
            "use_dev() {\n"
            f"  export VOX_PM_DRIVE_ID={OLD_ID}\n"
            "}\n"
        )
        self.assertNotEqual(gdrive.drive_id(), OLD_ID)

    # ── 編碼：真實 env 檔有中文註解，被 Windows/Big5 編輯器存過就會壞 ──

    def test_bom_prefixed_first_line_still_parsed(self):
        (self.cfg / "env").write_bytes(
            "﻿".encode("utf-8") + f"export VOX_PM_DRIVE_ID={NEW_ID}\n".encode("utf-8"))
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    def test_non_utf8_comment_does_not_discard_whole_file(self):
        # 中文註解被存成 cp950 → 舊實作整檔 UnicodeDecodeError 丟棄 → 坑 4 換皮再來
        data = "# 舊碟停用\n".encode("cp950") + f"export VOX_PM_DRIVE_ID={NEW_ID}\n".encode("utf-8")
        (self.cfg / "env").write_bytes(data)
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    def test_export_followed_by_tab(self):
        self._write_env(f"export\tVOX_PM_DRIVE_ID={NEW_ID}\n")
        self.assertEqual(gdrive.drive_id(), NEW_ID)

    # ── 垃圾值不可以「看起來有值」通過 if not x 守衛 ────────────

    def test_one_sided_quote_rejected(self):
        self._write_env(f'export VOX_PM_DRIVE_ID="{NEW_ID}\n')
        self.assertEqual(gdrive.drive_id(), "")

    def test_unexpanded_variable_rejected(self):
        # 不展開變數是刻意的，但字面值不可以被當成 driveId 拿去打 API
        self._write_env("export VOX_PM_DRIVE_ID=${OTHER:-fallback}\n")
        self.assertEqual(gdrive.drive_id(), "")

    def test_multi_var_export_rejected(self):
        self._write_env(f"export VOX_PM_DRIVE_ID={NEW_ID} VOX_X=1\n")
        self.assertEqual(gdrive.drive_id(), "")

    def test_command_substitution_rejected(self):
        self._write_env("export VOX_PM_DRIVE_ID=$(cat /etc/passwd)\n")
        self.assertEqual(gdrive.drive_id(), "")

    # ── 設定目錄本身 ────────────────────────────────────────

    def test_empty_config_dir_does_not_read_cwd(self):
        # VOX_PM_CONFIG_DIR="" 時 Path("") → "." → 會去讀當前目錄的 ./env，
        # 等於「誰能寫 cwd 誰就能決定上傳目的地」
        os.environ["VOX_PM_CONFIG_DIR"] = ""
        cwd = os.getcwd()
        try:
            os.chdir(self._tmp.name)
            (Path(self._tmp.name) / "env").write_text(
                f"export VOX_PM_DRIVE_ID={OLD_ID}\n", encoding="utf-8")
            self.assertNotEqual(gdrive.drive_id(), OLD_ID)
        finally:
            os.chdir(cwd)

    def test_value_shape_is_validated(self):
        self._write_env("export VOX_PM_DRIVE_ID=has space and / slash\n")
        self.assertEqual(gdrive.drive_id(), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
