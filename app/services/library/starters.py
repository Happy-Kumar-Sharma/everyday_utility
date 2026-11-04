"""Starter items (from the inference-pipeline workflow) created by “Add starter collections”. No secrets."""

STARTERS = [
    {
        "collection": "Local queries", "name": "images_for_prediction", "ext": "sql",
        "meta": {"description": "Image rows for the YoloV11 prediction CSV", "tags": ["ai_cdb", "pipeline"], "env": "local"},
        "content": """SELECT
    i.id AS image_id,
    i.image_name,
    i.s3_path,
    a.assessment_uuid,
    a.company_uuid,
    a.assessment_type
FROM public."ImageData" i
LEFT JOIN public."AssessmentData" a ON a.id = i.assessment_id
WHERE i.id IN ({{ids}});
""",
    },
    {
        "collection": "Local queries", "name": "predictions_by_image", "ext": "sql",
        "meta": {"description": "Damage predictions for images, filtered by damage type", "tags": ["ai_cdb", "pipeline"], "env": "local"},
        "content": """SELECT
    ddp.id AS pred_id, id.id AS image_id, ad.assessment_uuid AS assess_id,
    id.s3_path, ddp.score, ddp.bounding_box, ddp.polygon,
    ddp.damage_type_id AS damage_id, dt."name" AS damage_name,
    COALESCE((ddp."attributes" ->> 'disc_score')::numeric, 0) AS classifier_score,
    COALESCE((ddp."attributes" ->> 'exclude_pred'), 'false') AS exclude_pred
FROM "ImageData" id
JOIN "AssessmentData" ad ON ad.id = id.assessment_id
JOIN "DamageDetectionPredictions" ddp ON ddp.image_id = id.id
JOIN "DamageTypes" dt ON dt.id = ddp.damage_type_id
WHERE id.id IN ({{ids}})
  AND dt.id IN ({{damage_types:2,6,10,11,18,28}});
""",
    },
    {
        "collection": "Commands", "name": "migrate_prod_images_to_local", "ext": "sh",
        "meta": {"description": "Copy images for var/prod_to_local_image_ids.txt from prod into local ai_cdb", "tags": ["pipeline"]},
        "content": """cd ~/workspace/carscan.ai.centralizeddatabase
source venv/bin/activate
python var/prod_to_local_images_migration.py
""",
    },
    {
        "collection": "Commands", "name": "predict_batched", "ext": "sh",
        "meta": {"description": "Batched YoloV11 predictions from a CSV (resumable)", "tags": ["pipeline", "gpu"]},
        "content": """cd ~/workspace/carscan.ai.services_backup/Local_Model_YoloV11
source ../venv/bin/activate
export LD_LIBRARY_PATH=/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}
python3 predict_from_csv_batched.py -i {{input_csv:../20k_images_latest_for_pred.csv}} -o {{output_jsonl:local_20k_pred_parallel.jsonl}} \\
  --bucket prod-carscan-image-datasets --prefetch-workers 16 --queue-size 32
""",
    },
    {
        "collection": "Commands", "name": "predict_single_model", "ext": "sh",
        "meta": {"description": "Single-model predictions (debugging)", "tags": ["pipeline", "gpu"]},
        "content": """cd ~/workspace/carscan.ai.services_backup
source venv/bin/activate
cd Local_Model_YoloV11/
export LD_LIBRARY_PATH=/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}
CUDA_LAUNCH_BLOCKING=1 python3 predict_from_csv.py
""",
    },
    {
        "collection": "Commands", "name": "load_predictions_jsonl", "ext": "sh",
        "meta": {"description": "Load the predictions JSONL into local ai_cdb", "tags": ["pipeline"]},
        "content": """cd ~/workspace/carscan.ai.centralizeddatabase
source venv/bin/activate
python var/load_local_predictions_jsonl.py
""",
    },
    {
        "collection": "Mongo queries", "name": "find_by_uuid", "ext": "js",
        "meta": {"description": "Example: one document by uuid (edit the collection name)", "tags": ["example"]},
        "content": """db.getCollection("{{collection:assessments}}").find(
  { uuid: "{{uuid}}" }
).limit(5)
""",
    },
    {
        "collection": "Favourite apps", "name": "Everyday Utility", "ext": "url",
        "meta": {"description": "This app", "favorite": True},
        "content": "http://127.0.0.1:8765\n",
    },
]
