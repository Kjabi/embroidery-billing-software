"""Local capacity proxy for 25,000 normalized customers/orders.

This creates an isolated temporary SQLite database. It never reads or changes
the application database, Supabase project, backups, or customer files.
It is a development sizing signal, not a substitute for a Preview load test.
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import time


CUSTOMER_COUNT = 25_000


def main() -> None:
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="lalithas-capacity-") as directory:
        database_path = os.path.join(directory, "capacity.db")
        connection = sqlite3.connect(database_path)
        try:
            connection.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE INDEX ix_customers_phone ON customers(phone);
                CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, invoice_number TEXT NOT NULL UNIQUE,
                    order_date TEXT NOT NULL, total_amount REAL NOT NULL, paid_amount REAL NOT NULL, balance REAL NOT NULL, status TEXT NOT NULL);
                CREATE INDEX ix_orders_customer_id ON orders(customer_id);
                CREATE INDEX ix_orders_order_date ON orders(order_date);
                CREATE TABLE order_measurements (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, field_name TEXT NOT NULL, value TEXT NOT NULL);
                CREATE INDEX ix_order_measurements_order_id ON order_measurements(order_id);
                CREATE TABLE transactions (id INTEGER PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, reference TEXT NOT NULL);
                CREATE INDEX ix_transactions_date ON transactions(date);
            """)
            customers = [(i, f"Capacity Customer {i}", f"9{i:09d}"[-10:], "2026-10-29") for i in range(1, CUSTOMER_COUNT + 1)]
            orders = [(i, i, f"INV-2026-{i:05d}", "2026-10-29", 1000.0, 250.0, 750.0, "Partially Paid") for i in range(1, CUSTOMER_COUNT + 1)]
            measurements = [(i, i, "Bust", "36") for i in range(1, CUSTOMER_COUNT + 1)]
            transactions = [(i, "2026-10-29", "INCOME", 250.0, f"INV-2026-{i:05d}") for i in range(1, CUSTOMER_COUNT + 1)]
            connection.executemany("INSERT INTO customers VALUES (?, ?, ?, ?)", customers)
            connection.executemany("INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?)", orders)
            connection.executemany("INSERT INTO order_measurements VALUES (?, ?, ?, ?)", measurements)
            connection.executemany("INSERT INTO transactions VALUES (?, ?, ?, ?, ?)", transactions)
            connection.commit()

            query_started = time.perf_counter()
            assert connection.execute("SELECT * FROM customers WHERE phone = ?", (customers[-1][2],)).fetchone()
            assert len(connection.execute("SELECT * FROM orders ORDER BY id DESC LIMIT 100").fetchall()) == 100
            assert connection.execute("SELECT SUM(amount) FROM transactions WHERE date = ?", ("2026-10-29",)).fetchone()[0]
            query_seconds = time.perf_counter() - query_started
            bytes_on_disk = os.path.getsize(database_path)
        finally:
            connection.close()

    print(f"customers={CUSTOMER_COUNT}")
    print(f"elapsed_seconds={time.perf_counter() - started:.3f}")
    print(f"representative_query_seconds={query_seconds:.4f}")
    print(f"sqlite_database_megabytes={bytes_on_disk / (1024 * 1024):.2f}")
    print("result=local_proxy_only; run Preview load testing before production")


if __name__ == "__main__":
    main()
