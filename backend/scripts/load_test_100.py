"""Realistic 100-concurrent-user load test for the Lalitha's Apparel API.

Run against a production-like server, for example:

    APP_ENV=production ... uvicorn main:app --host 127.0.0.1 --port 8010 --workers 1

    ../.venv/bin/python scripts/load_test_100.py \
        --base-url http://127.0.0.1:8010 \
        --users 100 --duration 120 --server-pid <uvicorn pid>

The script logs in 100 independent sessions, runs a mixed read/write workload
(customer/order lists, finance, order creation, balance collection, PDF
generation, and one voice turn per user), samples the server CPU/RSS, and
writes a JSON report. It never treats a 5xx or transport error as success.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import statistics
import subprocess
import time
import uuid
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import httpx


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return ordered[index]


def latency_summary(values: list[float]) -> dict[str, float]:
    if not values:
        return {"count": 0, "p50": 0, "p95": 0, "p99": 0, "max": 0, "mean": 0}
    return {
        "count": len(values),
        "p50": round(percentile(values, 0.50), 2),
        "p95": round(percentile(values, 0.95), 2),
        "p99": round(percentile(values, 0.99), 2),
        "max": round(max(values), 2),
        "mean": round(statistics.fmean(values), 2),
    }


class Stats:
    def __init__(self) -> None:
        self.latencies: dict[str, list[float]] = defaultdict(list)
        self.statuses: Counter[str] = Counter()
        self.errors: list[dict[str, Any]] = []
        self.sample_order: dict[str, Any] | None = None
        self.voice_ok = 0
        self.voice_limited = 0
        self.created_orders: list[int] = []

    async def request(
        self,
        client: httpx.AsyncClient,
        method: str,
        path: str,
        *,
        op: str,
        headers: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> httpx.Response | None:
        started = time.perf_counter()
        try:
            response = await client.request(
                method, path, headers=headers, json=body, params=params
            )
        except Exception as exc:  # noqa: BLE001 - record any transport failure
            elapsed = (time.perf_counter() - started) * 1000
            self.latencies[op].append(elapsed)
            self.statuses["EXCEPTION"] += 1
            self.errors.append({"op": op, "method": method, "path": path, "error": repr(exc)})
            return None
        elapsed = (time.perf_counter() - started) * 1000
        self.latencies[op].append(elapsed)
        self.statuses[str(response.status_code)] += 1
        if response.status_code not in expected:
            self.errors.append(
                {
                    "op": op,
                    "method": method,
                    "path": path,
                    "status": response.status_code,
                    "body": response.text[:500],
                }
            )
        return response


async def login(client: httpx.AsyncClient, stats: Stats, username: str, password: str) -> str:
    response = await stats.request(
        client,
        "POST",
        "/api/login",
        op="login",
        body={"username": username, "password": password},
        expected=(200,),
    )
    if response is None or response.status_code != 200:
        raise RuntimeError(f"Login failed: {response.status_code if response else 'transport error'}")
    return response.json()["token"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def setup_data(
    client: httpx.AsyncClient, token: str, users: int, stats: Stats
) -> tuple[list[int], int, list[dict[str, str]]]:
    headers = auth(token)
    existing = (await client.get("/api/customers", headers=headers, params={"limit": 250})).json()
    customers = existing.get("items", existing)
    by_name = {customer["name"]: customer["id"] for customer in customers}

    for index in range(users + 20):
        name = f"Load Customer {index:03d}"
        if name in by_name:
            continue
        response = await stats.request(
            client,
            "POST",
            "/api/customers",
            op="setup_customer",
            headers=headers,
            body={"name": name, "phone": f"9{index:09d}", "city": "Madurai"},
        )
        if response is not None and response.status_code == 200:
            by_name[name] = response.json()["id"]

    customer_ids = [by_name[f"Load Customer {index:03d}"] for index in range(users + 20)]

    products = (await client.get("/api/products", headers=headers)).json()
    product = next(item for item in products if item["name"] == "Normal Blouse")
    templates = (await client.get("/api/templates", headers=headers)).json()
    template = next(item for item in templates if item["id"] == product["measurement_template_id"])
    measurements = [{"field_name": field, "value": "36 in"} for field in template["fields"]]
    return customer_ids, product["id"], measurements


def order_body(customer_id: int, product_id: int, measurements: list[dict[str, str]]) -> dict[str, Any]:
    today = date.today()
    return {
        "customer_id": customer_id,
        "product_id": product_id,
        "order_date": today.isoformat(),
        "delivery_date": (today + timedelta(days=10)).isoformat(),
        "description": "Concurrent load-test order",
        "base_amount": 800,
        "total_amount": 800,
        "paid_amount": 0,
        "measurements": measurements,
        "idempotency_key": str(uuid.uuid4()),
    }


async def run_user(
    user_id: int,
    token: str,
    client: httpx.AsyncClient,
    stats: Stats,
    customer_ids: list[int],
    product_id: int,
    measurements: list[dict[str, str]],
    deadline: float,
    voice_once: bool,
    think_min: float,
    think_max: float,
) -> None:
    headers = auth(token)
    created: list[int] = []
    iteration = 0
    rng = random.Random(1000 + user_id)

    if voice_once:
        await asyncio.sleep(rng.uniform(0, 2.0))
        response = await stats.request(
            client,
            "POST",
            "/api/voice/turn",
            op="voice_turn",
            headers=headers,
            body={"text": "How many pending orders today?"},
            expected=(200, 429),
        )
        if response is not None and response.status_code == 200:
            stats.voice_ok += 1
        elif response is not None and response.status_code == 429:
            stats.voice_limited += 1

    while time.perf_counter() < deadline:
        iteration += 1
        roll = rng.random()

        if roll < 0.22:
            await stats.request(
                client, "GET", "/api/customers", op="customers_list",
                headers=headers, params={"limit": 100},
            )
        elif roll < 0.44:
            await stats.request(
                client, "GET", "/api/orders", op="orders_list",
                headers=headers, params={"limit": 100},
            )
        elif roll < 0.52:
            await stats.request(client, "GET", "/api/products", op="products_list", headers=headers)
        elif roll < 0.58:
            await stats.request(client, "GET", "/api/templates", op="templates_list", headers=headers)
        elif roll < 0.70:
            await stats.request(client, "GET", "/api/finance", op="finance", headers=headers)
        elif roll < 0.76:
            await stats.request(client, "GET", "/api/finance/export.csv", op="finance_csv", headers=headers)
        elif roll < 0.86:
            body = order_body(
                customer_ids[(user_id + iteration) % len(customer_ids)],
                product_id,
                measurements,
            )
            response = await stats.request(
                client, "POST", "/api/orders", op="order_create", headers=headers, body=body
            )
            if response is not None and response.status_code == 200:
                payload = response.json()
                created.append(payload["id"])
                stats.created_orders.append(payload["id"])
                if stats.sample_order is None:
                    stats.sample_order = {"body": body, "response": payload}
        elif roll < 0.95 and created:
            order_id = created.pop(0)
            await stats.request(
                client,
                "POST",
                f"/api/orders/{order_id}/pay",
                op="order_pay",
                headers=headers,
                body={"additional_paid": 300, "idempotency_key": str(uuid.uuid4())},
            )
        elif created:
            order_id = created[0]
            await stats.request(
                client, "GET", f"/api/orders/{order_id}/pdf", op="invoice_pdf", headers=headers
            )
        else:
            await stats.request(client, "GET", "/api/orders", op="orders_list", headers=headers)

        await asyncio.sleep(rng.uniform(think_min, think_max))


async def sample_server(pid: int, stop: asyncio.Event, samples: list[dict[str, float]]) -> None:
    while not stop.is_set():
        try:
            output = subprocess.run(
                ["ps", "-o", "%cpu=,rss=", "-p", str(pid)],
                capture_output=True,
                text=True,
                check=False,
            ).stdout.strip()
            if output:
                cpu_text, rss_text = output.split()[:2]
                samples.append({"cpu_percent": float(cpu_text), "rss_mb": int(rss_text) / 1024})
        except Exception:  # noqa: BLE001 - sampling must never stop the test
            pass
        try:
            await asyncio.wait_for(stop.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8010")
    parser.add_argument("--users", type=int, default=100)
    parser.add_argument("--duration", type=float, default=120.0)
    parser.add_argument("--username", default=os.getenv("LOAD_USERNAME", "lalithas"))
    parser.add_argument("--password", default=os.getenv("LOAD_PASSWORD", "load-test-password"))
    parser.add_argument("--server-pid", type=int, default=0)
    parser.add_argument("--think-min", type=float, default=1.0)
    parser.add_argument("--think-max", type=float, default=2.5)
    parser.add_argument("--report", default="load-test-report.json")
    args = parser.parse_args()

    stats = Stats()
    limits = httpx.Limits(max_connections=args.users * 2, max_keepalive_connections=args.users)
    timeout = httpx.Timeout(60.0, connect=10.0)
    async with httpx.AsyncClient(base_url=args.base_url, limits=limits, timeout=timeout) as client:
        admin_token = await login(client, stats, args.username, args.password)
        customer_ids, product_id, measurements = await setup_data(
            client, admin_token, args.users, stats
        )
        print(f"Setup complete: {len(customer_ids)} customers, product {product_id}")

        # Every simulated user independently authenticates at the same time.
        login_started = time.perf_counter()
        tokens = await asyncio.gather(
            *(login(client, stats, args.username, args.password) for _ in range(args.users))
        )
        login_elapsed = time.perf_counter() - login_started
        print(f"{args.users} concurrent logins completed in {login_elapsed:.2f}s")

        samples: list[dict[str, float]] = []
        stop_sampling = asyncio.Event()
        sampler = asyncio.create_task(sample_server(args.server_pid, stop_sampling, samples)) if args.server_pid else None

        start = time.perf_counter()
        deadline = start + args.duration
        results = await asyncio.gather(
            *(
                run_user(
                    index, tokens[index], client, stats, customer_ids,
                    product_id, measurements, deadline, voice_once=True,
                    think_min=args.think_min, think_max=args.think_max,
                )
                for index in range(args.users)
            ),
            return_exceptions=True,
        )
        task_exceptions = [repr(item) for item in results if isinstance(item, BaseException)]
        elapsed = time.perf_counter() - start

        if sampler:
            stop_sampling.set()
            await sampler

        # Idempotency replay check after the concurrent writes.
        replay = None
        if stats.sample_order:
            sample = stats.sample_order
            before = (await client.get("/api/orders", headers=auth(admin_token), params={"limit": 1})).json()
            response = await client.post(
                "/api/orders", headers=auth(admin_token), json=sample["body"]
            )
            after = (await client.get("/api/orders", headers=auth(admin_token), params={"limit": 1})).json()
            replay = {
                "status": response.status_code,
                "same_id": response.status_code == 200 and response.json().get("id") == sample["response"]["id"],
                "idempotent_replay": response.json().get("idempotent_replay") if response.status_code == 200 else None,
                "order_count_before": before.get("total") if isinstance(before, dict) else None,
                "order_count_after": after.get("total") if isinstance(after, dict) else None,
            }

    total_requests = sum(stats.statuses.values())
    rejected_503 = stats.statuses.get("503", 0)
    server_errors = sum(
        count for code, count in stats.statuses.items()
        if (code.startswith("5") and code != "503") or code == "EXCEPTION"
    )
    all_latencies = [value for values in stats.latencies.values() for value in values]
    report = {
        "base_url": args.base_url,
        "users": args.users,
        "think_time_seconds": [args.think_min, args.think_max],
        "duration_seconds": round(elapsed, 2),
        "login_burst_seconds": round(login_elapsed, 2),
        "total_requests": total_requests,
        "throughput_rps": round(total_requests / elapsed, 2),
        "status_counts": dict(sorted(stats.statuses.items())),
        "server_errors": server_errors,
        "rejected_503": rejected_503,
        "server_error_rate_percent": round(100 * server_errors / total_requests, 3) if total_requests else 0,
        "all_latency_ms": latency_summary(all_latencies),
        "per_operation_ms": {op: latency_summary(values) for op, values in sorted(stats.latencies.items())},
        "voice_turns_ok": stats.voice_ok,
        "voice_turns_rate_limited": stats.voice_limited,
        "orders_created": len(stats.created_orders),
        "task_exceptions": task_exceptions,
        "idempotency_replay": replay,
        "server_samples": {
            "count": len(samples),
            "max_cpu_percent": round(max((s["cpu_percent"] for s in samples), default=0), 1),
            "avg_cpu_percent": round(statistics.fmean(s["cpu_percent"] for s in samples), 1) if samples else 0,
            "max_rss_mb": round(max((s["rss_mb"] for s in samples), default=0), 1),
            "avg_rss_mb": round(statistics.fmean(s["rss_mb"] for s in samples), 1) if samples else 0,
        },
        "errors": stats.errors[:50],
        "error_count": len(stats.errors),
    }
    Path(args.report).write_text(json.dumps(report, indent=2))
    print(json.dumps({key: report[key] for key in (
        "duration_seconds", "total_requests", "throughput_rps", "status_counts",
        "server_errors", "rejected_503", "all_latency_ms", "server_samples",
        "voice_turns_ok", "voice_turns_rate_limited", "orders_created",
        "idempotency_replay",
    )}, indent=2))
    print(f"Report written to {args.report}")


if __name__ == "__main__":
    asyncio.run(main())
