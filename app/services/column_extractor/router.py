from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.tabular import TabularError, read_table, resolve_file

from .logic import FormatOptions, format_values

router = APIRouter()


class ExtractRequest(BaseModel):
    path: str
    column: str
    sheet: str | None = None
    delimiter: str = "comma"
    custom_delimiter: str = ""
    quote: str = "none"
    wrap: str = "none"
    unique: bool = False
    skip_blank: bool = True
    trim: bool = True
    sort: str = "none"
    numeric_sort: bool = False
    per_line: int = Field(0, ge=0, le=100000)


def extract_column(path: str, column: str, sheet: str | None = None) -> list[str]:
    """All values of one column, as strings. Shared with other services (e.g. the inference pipeline)."""
    df = read_table(resolve_file(path), sheet or None)
    if column not in df.columns:
        raise TabularError(f"Column '{column}' not found. Available: {', '.join(df.columns)}")
    return df[column].astype(str).tolist()


@router.post("/extract")
def extract(req: ExtractRequest):
    try:
        values = extract_column(req.path, req.column, req.sheet)
        opts = FormatOptions(**req.model_dump(exclude={"path", "column", "sheet"}))
        return format_values(values, opts)
    except (TabularError, ValueError) as e:
        raise HTTPException(400, str(e)) from e
