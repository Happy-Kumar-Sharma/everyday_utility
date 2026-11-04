"""Pure formatting logic: turn a list of cell values into one delimited string."""

from __future__ import annotations

from dataclasses import dataclass

DELIMITERS = {
    "comma": ",",
    "comma_space": ", ",
    "newline": "\n",
    "comma_newline": ",\n",
    "tab": "\t",
    "dot": ".",
    "pipe": "|",
    "semicolon": ";",
    "space": " ",
}
QUOTES = {"none": "", "single": "'", "double": '"', "backtick": "`"}
WRAPS = {"none": ("", ""), "paren": ("(", ")"), "bracket": ("[", "]"), "brace": ("{", "}")}


@dataclass
class FormatOptions:
    delimiter: str = "comma"  # key of DELIMITERS or "custom"
    custom_delimiter: str = ""
    quote: str = "none"
    wrap: str = "none"
    unique: bool = False
    skip_blank: bool = True
    trim: bool = True
    sort: str = "none"  # none | asc | desc
    numeric_sort: bool = False
    per_line: int = 0  # >0: start a new line after every N items (long SQL IN lists stay readable)

    def resolved_delimiter(self) -> str:
        if self.delimiter == "custom":
            # let people type \n / \t in the custom box
            return self.custom_delimiter.replace("\\n", "\n").replace("\\t", "\t")
        if self.delimiter not in DELIMITERS:
            raise ValueError(f"unknown delimiter '{self.delimiter}'")
        return DELIMITERS[self.delimiter]


def _sort_key(numeric: bool):
    if not numeric:
        return lambda v: v
    def key(v: str):
        try:
            return (0, float(v), v)
        except ValueError:
            return (1, 0.0, v)  # non-numbers after numbers, alphabetically
    return key


def format_values(values: list[str], opts: FormatOptions) -> dict:
    if opts.quote not in QUOTES:
        raise ValueError(f"unknown quote '{opts.quote}'")
    if opts.wrap not in WRAPS:
        raise ValueError(f"unknown wrap '{opts.wrap}'")
    delim = opts.resolved_delimiter()

    total = len(values)
    items = [v.strip() if opts.trim else v for v in values]
    blanks = 0
    if opts.skip_blank:
        kept = [v for v in items if v.strip()]
        blanks = len(items) - len(kept)
        items = kept
    duplicates = 0
    if opts.unique:
        before = len(items)
        items = list(dict.fromkeys(items))  # keeps first-seen order
        duplicates = before - len(items)
    if opts.sort in ("asc", "desc"):
        items.sort(key=_sort_key(opts.numeric_sort), reverse=opts.sort == "desc")

    q = QUOTES[opts.quote]
    if q:
        # SQL-style escaping: a quote inside a value is doubled
        items = [q + v.replace(q, q + q) + q for v in items]

    if opts.per_line and opts.per_line > 0 and "\n" not in delim:
        sep = delim.rstrip()
        chunks = [delim.join(items[i : i + opts.per_line]) for i in range(0, len(items), opts.per_line)]
        body = (sep + "\n").join(chunks)
    else:
        body = delim.join(items)

    start, end = WRAPS[opts.wrap]
    return {
        "text": f"{start}{body}{end}",
        "count": len(items),
        "total_rows": total,
        "blank_skipped": blanks,
        "duplicates_removed": duplicates,
    }
