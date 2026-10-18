# Generates the Parquet fixtures with pyarrow (tested with 26.0.0):
#   python test/fixtures/parquet/make.py
import datetime
import decimal
import os

import pyarrow as pa
import pyarrow.parquet as pq

here = os.path.dirname(os.path.abspath(__file__))
rows = 300
long_output = " ".join(f"token{i}" for i in range(4000)) + " END"
table = pa.table({
    "id": [f"case-{i}" for i in range(rows)],
    "output": [long_output if i == 0 else f"answer {i}" for i in range(rows)],
    "score": [i / rows for i in range(rows)],
    "passed": [i % 3 != 0 for i in range(rows)],
    "meta": pa.array(
        [{"model": "model-a" if i % 2 else "model-b", "latency_ms": 100 + i, "usage": {"in": i, "out": 2 * i}} for i in range(rows)],
        pa.struct([("model", pa.string()), ("latency_ms", pa.int32()), ("usage", pa.struct([("in", pa.int64()), ("out", pa.int64())]))]),
    ),
    "tags": [["eval", f"bucket-{i % 4}"] if i % 5 else [] for i in range(rows)],
    "created": pa.array([datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(minutes=i) for i in range(rows)], pa.timestamp("us", tz="UTC")),
    "cost": pa.array([decimal.Decimal(i) / 100 for i in range(rows)], pa.decimal128(10, 4)),
    "big": pa.array([2**62 + i for i in range(rows)], pa.int64()),
    "blob": pa.array([bytes([i % 256, 1, 2]) for i in range(rows)], pa.binary()),
    "note": [None if i % 2 else f"note {i}" for i in range(rows)],
})
pq.write_table(table, os.path.join(here, "evals.parquet"), compression="snappy", row_group_size=100, write_page_index=True)

small = table.slice(0, 5).select(["id", "output", "score", "meta"])
small = small.set_column(1, "output", pa.array([f"short answer {i}" for i in range(5)]))
for codec in ["none", "gzip", "brotli", "zstd", "lz4"]:
    pq.write_table(small, os.path.join(here, f"codec-{codec}.parquet"), compression=codec)

deep = pa.table({"a": [{"b": {"c": {"d": 1}}}]})
pq.write_table(deep, os.path.join(here, "deep.parquet"))

# wide-5000.parquet.gz: 5,000 int8 columns, one row, gzipped to keep the repo small (about 100 KB).
import gzip
wide = pa.table({f"c{i}": pa.array([i % 100], pa.int8()) for i in range(5000)})
wide_path = os.path.join(here, "wide-5000.parquet")
pq.write_table(wide, wide_path, compression="none", write_statistics=False)
with open(wide_path, "rb") as source, gzip.open(wide_path + ".gz", "wb", compresslevel=9) as target:
    target.write(source.read())
os.remove(wide_path)
