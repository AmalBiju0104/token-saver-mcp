"""
data_pipeline.py

Main ETL pipeline for processing raw sensor data from IoT devices.
This module handles ingestion, validation, transformation, and storage
of time-series measurements from distributed sensor networks.

Author: Engineering Team
Version: 3.4.1
Last Modified: 2024-01-15

Notes:
    - Requires Python 3.10+
    # This comment style should also be stripped
    - Uses pandas for vectorized transformations
    - Writes to ClickHouse via HTTP interface
"""

import os  # standard library
import json  # for parsing payloads
import logging  # structured logging
from datetime import datetime, timezone  # timestamp handling
from typing import Optional, List, Dict, Any  # type hints

import pandas as pd  # data manipulation
import requests  # HTTP client for ClickHouse writes

# Module-level logger
logger = logging.getLogger(__name__)  # named logger, configured at app level

# Configuration from environment
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://localhost:8123")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "1000"))  # rows per write batch
MAX_RETRIES = 3  # retry attempts for failed writes


def ingest_payload(raw: str) -> Dict[str, Any]:
    """
    Parse a raw JSON string from the message queue into a structured dict.

    The payload format is:
        {
            "device_id": str,
            "timestamp": ISO8601 string,
            "measurements": {metric_name: float}
        }

    Args:
        raw: Raw JSON string from Kafka/SQS

    Returns:
        Parsed and lightly validated payload dict

    Raises:
        ValueError: If required fields are missing or malformed
    """
    # Parse JSON - let it raise on invalid JSON
    payload = json.loads(raw)

    # Validate required top-level fields
    required = {"device_id", "timestamp", "measurements"}
    missing = required - payload.keys()
    if missing:
        raise ValueError(f"Missing required fields: {missing}")  # fail fast

    # Normalize timestamp to UTC
    ts = datetime.fromisoformat(payload["timestamp"])
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)  # assume UTC if naive
    payload["timestamp"] = ts.isoformat()

    return payload


def validate_measurements(measurements: Dict[str, Any]) -> Dict[str, float]:
    """
    Validate and coerce measurement values to float.

    Drops any measurement where:
    - Value is None or missing
    - Value cannot be coerced to float
    - Value is NaN or infinite

    Args:
        measurements: Raw dict of metric_name -> value

    Returns:
        Cleaned dict with only valid float values
    """
    import math  # local import to avoid top-level cost

    cleaned = {}
    for key, val in measurements.items():
        try:
            f = float(val)  # coerce strings like "3.14"
            if math.isfinite(f):  # drop NaN and inf
                cleaned[key] = f
        except (TypeError, ValueError):
            # Log and skip - don't crash the pipeline on bad sensor data
            logger.warning("Dropping invalid measurement %s=%r", key, val)

    return cleaned


def transform_to_rows(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Explode a single payload into one row per measurement for columnar storage.

    Args:
        payload: Validated payload from ingest_payload()

    Returns:
        List of row dicts ready for insertion
    """
    # One row per metric
    rows = []
    for metric, value in payload["measurements"].items():
        rows.append({
            "device_id": payload["device_id"],
            "timestamp": payload["timestamp"],
            "metric": metric,
            "value": value,
        })
    return rows  # may be empty if measurements was empty


def write_to_clickhouse(rows: List[Dict[str, Any]], table: str = "sensor_data") -> int:
    """
    Batch-insert rows into ClickHouse using JSONEachRow format.

    Args:
        rows: List of row dicts
        table: Target ClickHouse table name

    Returns:
        Number of rows successfully written

    Raises:
        RuntimeError: If all retry attempts are exhausted
    """
    if not rows:
        return 0  # nothing to write

    # Split into batches to avoid oversized HTTP requests
    written = 0
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i : i + BATCH_SIZE]
        ndjson = "\n".join(json.dumps(r) for r in batch)  # newline-delimited JSON

        for attempt in range(MAX_RETRIES):
            try:
                resp = requests.post(
                    CLICKHOUSE_URL,
                    params={"query": f"INSERT INTO {table} FORMAT JSONEachRow"},
                    data=ndjson,
                    timeout=30,  # seconds
                )
                resp.raise_for_status()
                written += len(batch)
                break  # success - move to next batch
            except requests.RequestException as exc:
                logger.error("Write attempt %d failed: %s", attempt + 1, exc)
                if attempt == MAX_RETRIES - 1:
                    raise RuntimeError(f"Failed after {MAX_RETRIES} attempts") from exc

    return written
