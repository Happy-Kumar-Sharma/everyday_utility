"""SQL templates for the pipeline. Ids are validated ints, so inlining them is safe."""

from __future__ import annotations

import re


def _id_list(ids: list[int], per_line: int = 20) -> str:
    rows = [",".join(str(int(i)) for i in ids[n : n + per_line]) for n in range(0, len(ids), per_line)]
    return ",\n    ".join(rows)


def parse_int_list(text: str) -> list[int]:
    tokens = [t for t in re.split(r"[\s,;]+", text or "") if t]
    bad = [t for t in tokens if not t.isdigit()]
    if bad:
        raise ValueError(f"not integers: {', '.join(bad[:5])}")
    return [int(t) for t in tokens]


def images_for_prediction(ids: list[int]) -> str:
    if not ids:
        raise ValueError("the ids file is empty, set image ids in step 1")
    return f"""SELECT
    i.id AS image_id,
    i.image_name,
    i.s3_path,
    a.assessment_uuid,
    a.company_uuid,
    a.assessment_type
FROM public."ImageData" i
LEFT JOIN public."AssessmentData" a ON a.id = i.assessment_id
WHERE i.id IN (
    {_id_list(ids)}
)
ORDER BY i.id;
"""


def predictions(ids: list[int], damage_type_ids: list[int]) -> str:
    if not ids:
        raise ValueError("the ids file is empty, set image ids in step 1")
    damage_filter = f"\n  AND dt.id IN ({','.join(map(str, damage_type_ids))})" if damage_type_ids else ""
    return f"""SELECT
    ddp.id AS pred_id,
    id.id AS image_id,
    ad.assessment_uuid AS assess_id,
    id.s3_path,
    ddp.score,
    ddp.bounding_box,
    ddp.polygon,
    ddp.damage_type_id AS damage_id,
    dt."name" AS damage_name,
    COALESCE((ddp."attributes" ->> 'disc_score')::numeric, 0) AS classifier_score,
    COALESCE((ddp."attributes" ->> 'exclude_pred'), 'false') AS exclude_pred
FROM "ImageData" id
JOIN "AssessmentData" ad ON ad.id = id.assessment_id
JOIN "DamageDetectionPredictions" ddp ON ddp.image_id = id.id
JOIN "DamageTypes" dt ON dt.id = ddp.damage_type_id
WHERE id.id IN (
    {_id_list(ids)}
){damage_filter}
ORDER BY id.id, ddp.id;
"""
