"""Private Supabase Storage helpers for backend-only access.

This module intentionally never exposes the service-role key to the frontend.
All object paths are caller-generated and uploads default to no-overwrite.
"""
from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import certifi
import httpx


class StorageError(RuntimeError):
    """Sanitized Storage API error that never includes credentials or file data."""


def _config() -> tuple[str, str]:
    base_url = os.getenv("SUPABASE_URL", os.getenv("NEXT_PUBLIC_SUPABASE_URL", "")).rstrip("/")
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", os.getenv("SUPABASE_SECRET_KEY", ""))
    return base_url, service_key


def is_configured() -> bool:
    base_url, service_key = _config()
    return bool(base_url and service_key)


def _endpoint(path: str) -> tuple[str, dict[str, str]]:
    base_url, service_key = _config()
    if not base_url or not service_key:
        raise StorageError(
            "Private Supabase Storage is not configured. Set SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY in the backend environment."
        )
    return f"{base_url}/storage/v1/{path.lstrip('/')}", {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
    }


def _object_path(bucket: str, key: str) -> str:
    if not bucket or not key or key.startswith("/") or ".." in key.split("/"):
        raise ValueError("Invalid Storage bucket or object key")
    return f"{quote(bucket, safe='')}/{quote(key, safe='/')}"


def upload_bytes(
    bucket: str,
    key: str,
    payload: bytes,
    content_type: str,
    *,
    upsert: bool = False,
) -> str:
    """Upload bytes to a private bucket; collision fails unless explicitly allowed."""
    endpoint, headers = _endpoint(f"object/{_object_path(bucket, key)}")
    headers.update({
        "Content-Type": content_type,
        "x-upsert": "true" if upsert else "false",
    })
    try:
        with httpx.Client(timeout=60.0, verify=certifi.where()) as client:
            response = client.post(endpoint, content=payload, headers=headers)
            if response.status_code >= 400:
                if response.status_code == 409:
                    raise StorageError("Supabase Storage object already exists; refusing to overwrite it.")
                raise StorageError(f"Supabase Storage upload failed with HTTP {response.status_code}.")
    except httpx.RequestError as exc:
        raise StorageError("Could not connect to Supabase Storage for upload.") from exc
    return key


def download_bytes(bucket: str, key: str) -> bytes:
    endpoint, headers = _endpoint(f"object/{_object_path(bucket, key)}")
    try:
        with httpx.Client(timeout=60.0, verify=certifi.where()) as client:
            response = client.get(endpoint, headers=headers)
            if response.status_code >= 400:
                raise StorageError(f"Supabase Storage download failed with HTTP {response.status_code}.")
            return response.content
    except httpx.RequestError as exc:
        raise StorageError("Could not connect to Supabase Storage for download.") from exc


def create_signed_url(bucket: str, key: str, expires_in: int = 300) -> str:
    """Create an absolute short-lived URL for an object in a private bucket."""
    if not 1 <= int(expires_in) <= 3600:
        raise ValueError("Signed URL expiry must be between 1 and 3600 seconds")
    endpoint, headers = _endpoint(f"object/sign/{_object_path(bucket, key)}")
    headers["Content-Type"] = "application/json"
    base_url, _ = _config()
    try:
        with httpx.Client(timeout=30.0, verify=certifi.where()) as client:
            response = client.post(endpoint, json={"expiresIn": int(expires_in)}, headers=headers)
            if response.status_code >= 400:
                raise StorageError(f"Supabase Storage signed-URL request failed with HTTP {response.status_code}.")
            data: dict[str, Any] = response.json()
    except httpx.RequestError as exc:
        raise StorageError("Could not connect to Supabase Storage to create a signed URL.") from exc
    except ValueError as exc:
        raise StorageError("Supabase Storage returned an invalid signed-URL response.") from exc

    signed_url = data.get("signedURL") or data.get("signedUrl")
    if not isinstance(signed_url, str) or not signed_url:
        raise StorageError("Supabase Storage did not return a signed URL.")
    if signed_url.startswith("https://") or signed_url.startswith("http://"):
        return signed_url
    if signed_url.startswith("/storage/v1/"):
        return f"{base_url}{signed_url}"
    if signed_url.startswith("/"):
        return f"{base_url}/storage/v1{signed_url}"
    return f"{base_url}/storage/v1/{signed_url}"


def delete_object(bucket: str, key: str) -> None:
    """Best-effort cleanup helper for an upload whose DB transaction failed."""
    endpoint, headers = _endpoint(f"object/{quote(bucket, safe='')}")
    headers["Content-Type"] = "application/json"
    try:
        with httpx.Client(timeout=30.0, verify=certifi.where()) as client:
            response = client.request("DELETE", endpoint, json={"prefixes": [key]}, headers=headers)
            if response.status_code >= 400:
                raise StorageError(f"Supabase Storage cleanup failed with HTTP {response.status_code}.")
    except httpx.RequestError as exc:
        raise StorageError("Could not connect to Supabase Storage for cleanup.") from exc



def verify_private_bucket(bucket: str, required_mime_types: set[str] | None = None) -> dict[str, Any]:
    """Check the bucket exists, is private, and has the expected MIME allow-list."""
    endpoint, headers = _endpoint(f"bucket/{quote(bucket, safe='')}")
    try:
        with httpx.Client(timeout=20.0, verify=certifi.where()) as client:
            response = client.get(endpoint, headers=headers)
            if response.status_code >= 400:
                raise StorageError(f"Supabase Storage bucket check failed for '{bucket}' with HTTP {response.status_code}.")
            info = response.json()
    except httpx.RequestError as exc:
        raise StorageError(f"Could not verify Supabase Storage bucket '{bucket}'.") from exc
    except ValueError as exc:
        raise StorageError(f"Supabase Storage returned invalid bucket metadata for '{bucket}'.") from exc

    if info.get("public") is not False:
        raise StorageError(f"Storage bucket '{bucket}' must be private (public=false).")
    if required_mime_types is not None:
        allowed = info.get("allowed_mime_types")
        if not isinstance(allowed, list) or not required_mime_types.issubset(set(allowed)):
            raise StorageError(
                f"Storage bucket '{bucket}' must allow these MIME types: {', '.join(sorted(required_mime_types))}."
            )
    return info

def list_objects(bucket: str, prefix: str = "", *, max_objects: int = 5000) -> list[dict[str, Any]]:
    """List files recursively below a prefix, using bounded paginated requests."""
    endpoint, headers = _endpoint(f"object/list/{quote(bucket, safe='')}")
    headers["Content-Type"] = "application/json"
    folders = [prefix.strip("/")]
    seen_folders: set[str] = set()
    result: list[dict[str, Any]] = []
    try:
        with httpx.Client(timeout=60.0, verify=certifi.where()) as client:
            while folders:
                folder = folders.pop(0)
                if folder in seen_folders:
                    continue
                seen_folders.add(folder)
                offset = 0
                while True:
                    response = client.post(
                        endpoint,
                        json={
                            "prefix": folder,
                            "limit": 100,
                            "offset": offset,
                            "sortBy": {"column": "name", "order": "asc"},
                        },
                        headers=headers,
                    )
                    if response.status_code >= 400:
                        raise StorageError(f"Supabase Storage listing failed with HTTP {response.status_code}.")
                    rows = response.json()
                    if not isinstance(rows, list):
                        raise StorageError("Supabase Storage returned an invalid object listing.")
                    for item in rows:
                        name = item.get("name")
                        if not isinstance(name, str) or not name or name in {".", ".."}:
                            continue
                        full_key = f"{folder}/{name}" if folder else name
                        metadata = item.get("metadata") or {}
                        is_folder = item.get("id") is None and not metadata
                        if is_folder:
                            folders.append(full_key)
                        else:
                            result.append({**item, "key": full_key})
                            if len(result) > max_objects:
                                raise StorageError(
                                    f"Storage listing exceeded the configured safety limit of {max_objects} objects."
                                )
                    if len(rows) < 100:
                        break
                    offset += len(rows)
    except httpx.RequestError as exc:
        raise StorageError("Could not connect to Supabase Storage to list objects.") from exc
    return result
