"""User-editable settings for the inference pipeline (persisted via the core settings store)."""

from app.core.registry import SettingField as F

AICDB = "~/workspace/carscan.ai.centralizeddatabase"
SERVICES = "~/workspace/carscan.ai.services_backup"
MODEL_DIR = f"{SERVICES}/Local_Model_YoloV11"

SETTINGS = (
    # repos & environments
    F("aicdb_repo", "AI CDB repo", AICDB, "path", "carscan.ai.centralizeddatabase checkout", "Repos"),
    F("aicdb_venv", "AI CDB venv", f"{AICDB}/venv", "path", "activated before the migration / load scripts", "Repos"),
    F("local_env_file", "Local DB credentials", f"{AICDB}/var/local_credentials.sh", "path",
      "export POSTGRES_* file used for the SQL steps and the loader", "Repos"),
    F("model_dir", "Model folder", MODEL_DIR, "path", "folder with predict_from_csv*.py", "Repos"),
    F("services_venv", "Model venv", f"{SERVICES}/venv", "path", "activated before running predictions", "Repos"),
    F("ld_library_path", "LD_LIBRARY_PATH prefix", "/usr/lib/wsl/lib", "text", "WSL CUDA libs; empty to skip", "Repos"),
    # files flowing between steps
    F("ids_file", "Image ids file", f"{AICDB}/var/prod_to_local_image_ids.txt", "path",
      "step 1 writes it, migration + SQL steps read it", "Files"),
    F("pred_input_csv", "Images CSV for prediction", f"{SERVICES}/20k_images_latest_for_pred.csv", "path",
      "step 3 exports it, step 4 reads it", "Files"),
    F("pred_output_jsonl", "Predictions JSONL", f"{MODEL_DIR}/local_20k_pred_parallel.jsonl", "path",
      "step 4 appends to it (resumable), step 5 loads it", "Files"),
    # prediction knobs
    F("bucket", "S3 bucket", "prod-carscan-image-datasets", "text", "", "Prediction"),
    F("prefetch_workers", "Prefetch workers", 16, "int", "S3 download / decode threads", "Prediction"),
    F("queue_size", "Queue size", 32, "int", "decoded-image queue depth", "Prediction"),
    F("model_batch_size", "Model batch size", 1, "int", "images per GPU forward pass (1 = legacy path)", "Prediction"),
    F("fp16", "FP16 autocast", False, "bool", "faster on Ampere; validate on a sample first", "Prediction"),
    # loading
    F("model_name", "AIModels.name", "local_damage_ensemble_rtm_v8", "text", "", "Load"),
    F("model_version", "AIModels.version", "local-20k", "text", "", "Load"),
    F("damage_type_ids", "Damage type ids", "2,6,10,11,18,28", "text", "filter for the predictions query; empty = all", "Load"),
)
