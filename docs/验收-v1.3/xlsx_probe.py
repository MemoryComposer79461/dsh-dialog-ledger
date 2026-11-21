#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
验收辅助：用 openpyxl 打开 xlsx 产物，导出「只读事实」为 JSON（不做任何断言）。

用法：
  python xlsx_probe.py <out.json> <file1.xlsx> [file2.xlsx ...]

输出（out.json）是一个数组，每项：
  {
    "file": 绝对路径, "ok": true, "error": null,
    "sheetOrder": ["说明", "周一", ...],
    "sheets": [
      { "name": "说明", "dimensions": "A1:G54", "maxRow": 54, "maxColumn": 7,
        "freeze": null, "cells": {"A1": {"v": "...", "t": "s"}, ...} },
      { "name": "周一", "...": "...", "headers": [...],
        "dv": [{"type":"custom","sqref":"A2:A121","formula1":"...","allowBlank":true,"showErrorMessage":false,"errorTitle":"..."}],
        "rows": [{"r": 2, "A": "...", "B": "...", ...}, ...],   # 只含非空单元格（行号 2..121）
        "rowNumbers": [2,3] },
      ...
      { "name": "周统计", "cells": {...} }
    ],
    "strings": ["所有字符串单元格值（用于 Z 时间扫描 / 自相矛盾文字扫描）"]
  }

设计原则：本脚本只「读」，判定逻辑全部在 Node 验收脚本里，保证判据与证据分离。
"""
import json
import sys

try:
    import openpyxl
except Exception as e:  # pragma: no cover
    sys.stderr.write('openpyxl import failed: %r\n' % (e,))
    sys.exit(2)


def cells_of(ws, max_row, max_col):
    out = {}
    for row in ws.iter_rows(min_row=1, max_row=max_row, max_col=max_col):
        for c in row:
            if c.value is not None:
                out[c.coordinate] = {"v": c.value, "t": c.data_type}
    return out


def probe_file(path):
    fact = {"file": path, "ok": False, "error": None, "sheetOrder": [], "sheets": [], "strings": []}
    try:
        wb = openpyxl.load_workbook(path, data_only=False)
    except Exception as e:
        fact["error"] = repr(e)
        return fact
    fact["ok"] = True
    fact["sheetOrder"] = list(wb.sheetnames)
    all_strings = []
    for ws in wb.worksheets:
        item = {
            "name": ws.title,
            "dimensions": ws.dimensions,
            "maxRow": ws.max_row,
            "maxColumn": ws.max_column,
            "freeze": ws.freeze_panes,
            "sheetStrings": [],
        }
        if ws.title == "说明":
            item["cells"] = cells_of(ws, 60, 8)
        elif ws.title == "周统计":
            item["cells"] = cells_of(ws, 20, 8)
        else:
            # 日表：表头 + dataValidations + 非空数据行
            item["headers"] = [ws.cell(row=1, column=c).value for c in range(1, ws.max_column + 1)]
            dv_list = []
            for dv in ws.data_validations.dataValidation:
                dv_list.append({
                    "type": dv.type,
                    "sqref": str(dv.sqref),
                    "formula1": dv.formula1,
                    "allowBlank": dv.allow_blank,
                    "showErrorMessage": dv.showErrorMessage,
                    "errorTitle": dv.errorTitle,
                })
            item["dv"] = dv_list
            rows = []
            row_numbers = []
            for r in range(2, 122):
                row = {}
                for c in range(1, 11):
                    cell = ws.cell(row=r, column=c)
                    if cell.value is not None:
                        row[openpyxl.utils.get_column_letter(c)] = cell.value
                if row:
                    row["r"] = r
                    rows.append(row)
                if ws.cell(row=r, column=1).value is not None:
                    row_numbers.append(r)
            item["rows"] = rows
            item["rowNumbers"] = row_numbers
            for v in item["headers"]:
                if isinstance(v, str):
                    all_strings.append(v)
        for cell in item.get("cells", {}).values():
            if isinstance(cell["v"], str):
                item["sheetStrings"].append(cell["v"])
                all_strings.append(cell["v"])
        for row in item.get("rows", []):
            for k, v in row.items():
                if k == "r":
                    continue
                if isinstance(v, str):
                    item["sheetStrings"].append(v)
                    all_strings.append(v)
        fact["sheets"].append(item)
    fact["strings"] = all_strings
    return fact


def main():
    if len(sys.argv) < 3:
        sys.stderr.write(__doc__)
        return 2
    out_path = sys.argv[1]
    files = sys.argv[2:]
    out = []
    for f in files:
        out.append(probe_file(f))
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
