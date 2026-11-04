"""Reading CSV / TSV / Excel files into string-typed DataFrames.

Everything is read as text so ids like 007 or 6838864 come back exactly as written (no floats, no NaN).
"""

from __future__ import annotations

import csv
from pathlib import Path

import pandas as pd

EXCEL_EXTS = {".xlsx", ".xlsm", ".xls"}
TEXT_EXTS = {".csv", ".tsv", ".txt"}
SUPPORTED_EXTS = EXCEL_EXTS | TEXT_EXTS


class TabularError(ValueError):
    pass


def resolve_file(path: str) -> Path:
    if not path or not path.strip():
        raise TabularError("No file selected")
    p = Path(path.strip()).expanduser()
    if not p.is_file():
        raise TabularError(f"File not found: {p}")
    if p.suffix.lower() not in SUPPORTED_EXTS:
        raise TabularError(f"Unsupported file type '{p.suffix}'. Use one of: {', '.join(sorted(SUPPORTED_EXTS))}")
    return p


def sheet_names(path: Path) -> list[str]:
    if path.suffix.lower() not in EXCEL_EXTS:
        return []
    try:
        with pd.ExcelFile(path) as xf:
            return [str(s) for s in xf.sheet_names]
    except ImportError as e:
        raise TabularError(f"Could not read {path.name}: {e} (old .xls files need `pip install xlrd`)") from e
    except (ValueError, OSError) as e:
        raise TabularError(f"Could not read {path.name}: {e}") from e


def _sniff_delimiter(path: Path) -> str:
    if path.suffix.lower() == ".tsv":
        return "\t"
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as f:
        sample = f.read(64 * 1024)
    header = sample.splitlines()[0] if sample else ""
    try:
        delim = csv.Sniffer().sniff(sample, delimiters=",\t;|").delimiter
    except csv.Error:
        return ","
    # a delimiter that is not in the header line is a guess from cell values (e.g. ';' inside paths
    # of a single-column file); splitting on it would corrupt the data
    return delim if delim in header else ","


def read_table(path: Path, sheet: str | None = None, nrows: int | None = None) -> pd.DataFrame:
    try:
        if path.suffix.lower() in EXCEL_EXTS:
            df = pd.read_excel(path, sheet_name=sheet or 0, dtype=str, keep_default_na=False, nrows=nrows)
        else:
            df = pd.read_csv(
                path,
                sep=_sniff_delimiter(path),
                dtype=str,
                keep_default_na=False,
                encoding="utf-8-sig",  # strips the BOM Excel puts in front of the first header
                encoding_errors="replace",
                index_col=False,  # rows with extra fields must never silently become the index
                nrows=nrows,
            )
    except ImportError as e:
        raise TabularError(f"Could not read {path.name}: {e} (old .xls files need `pip install xlrd`)") from e
    except (ValueError, pd.errors.ParserError, OSError) as e:
        raise TabularError(f"Could not read {path.name}: {e}") from e
    df.columns = [str(c).strip() for c in df.columns]
    return df


def describe(path: Path, sheet: str | None = None, preview_rows: int = 10) -> dict:
    """Columns, row count and a small preview, for the file-picker UI."""
    df = read_table(path, sheet)
    return {
        "path": str(path),
        "name": path.name,
        "sheets": sheet_names(path),
        "sheet": sheet,
        "columns": list(df.columns),
        "row_count": len(df),
        "preview": df.head(preview_rows).to_dict(orient="records"),
    }
