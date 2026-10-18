# Writes openpyxl-formulas.xlsx: formulas that openpyxl stores as <f>..</f><v></v> because it never calculates.
# Run with openpyxl 3.1: python openpyxl-formulas.py openpyxl-formulas.xlsx

import sys
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = "results"
ws.append(["id", "model", "score"])
for i, (m, s) in enumerate([("gpt-x-mini", 0.8), ("gpt-x", 0.9), ("gpt-x-mini", 0.7)], start=1):
    ws.append([i, m, s])
summary = wb.create_sheet("summary")
summary.append(["model", "runs", "mean"])
summary.append(["gpt-x-mini", '=COUNTIF(results!B:B,"gpt-x-mini")', '=AVERAGEIF(results!B:B,"gpt-x-mini",results!C:C)'])
summary.append(["gpt-x", '=COUNTIF(results!B:B,"gpt-x")', "=C2/B2"])
summary["D1"] = "note"
summary["D2"] = "=\"label \"&A2"
wb.save(sys.argv[1])
