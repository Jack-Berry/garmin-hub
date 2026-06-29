#!/usr/local/bin/python3.13
# recovery_inspect.py — disposable, pulls raw recovery JSON for schema design.
#
# Stage 1c step 1: dump a few days of HRV / resting HR / sleep + related
# wellness shapes so we can see the payloads before designing a table.
# Disposable — delete once the recovery schema is settled.
#
# Reuses the .env creds + cached .garth token (same as ingest.py), so no MFA.
# Run with Homebrew Python 3.13 (NOT Apple's 3.9):
#     /usr/local/bin/python3.13 ingest/recovery_inspect.py

import os
import json
import warnings
from pathlib import Path
from datetime import date, timedelta

# --- Suppress the harmless LibreSSL-vs-OpenSSL warning (NotOpenSSLWarning) ---
try:
    from urllib3.exceptions import NotOpenSSLWarning
    warnings.filterwarnings("ignore", category=NotOpenSSLWarning)
except Exception:
    pass
warnings.filterwarnings("ignore", message=r".*OpenSSL.*")

from dotenv import load_dotenv
import garminconnect

INGEST_DIR = Path(__file__).resolve().parent
ENV_PATH = INGEST_DIR / ".env"
TOKENSTORE = INGEST_DIR / ".garth"
OUT_PATH = INGEST_DIR / "recovery_dump.json"

DAYS = 4  # how many recent days to sample per shape


def prompt_mfa():
    return input("Enter Garmin MFA / 2FA code: ").strip()


def login():
    load_dotenv(ENV_PATH)
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    if not email or not password:
        raise SystemExit("GARMIN_EMAIL / GARMIN_PASSWORD not set in ingest/.env")
    g = garminconnect.Garmin(email, password, prompt_mfa=prompt_mfa)
    try:
        g.login(str(TOKENSTORE))
        print("Resumed cached Garmin session.")
    except Exception:
        print("No valid cached session — performing full login.")
        g.login()
        g.garth.dump(str(TOKENSTORE))
    return g


def truncate_lists(obj, n=5):
    """Recursively cap every list to its first n elements (keeps file small).

    Recovery payloads carry dense per-timestamp arrays (HRV readings, body
    battery, stress, sleep movement); we only need to see their shape."""
    if isinstance(obj, dict):
        return {k: truncate_lists(v, n) for k, v in obj.items()}
    if isinstance(obj, list):
        return [truncate_lists(x, n) for x in obj[:n]]
    return obj


# Each entry: (key, fn(g, cdate)) — all single-date except body_battery.
DATE_SHAPES = [
    ("sleep_data", lambda g, d: g.get_sleep_data(d)),
    ("hrv_data", lambda g, d: g.get_hrv_data(d)),
    ("rhr_day", lambda g, d: g.get_rhr_day(d)),
    ("user_summary", lambda g, d: g.get_user_summary(d)),
    ("stats", lambda g, d: g.get_stats(d)),
    ("stats_and_body", lambda g, d: g.get_stats_and_body(d)),
    ("training_readiness", lambda g, d: g.get_training_readiness(d)),
    ("training_status", lambda g, d: g.get_training_status(d)),
    ("all_day_stress", lambda g, d: g.get_all_day_stress(d)),
    ("respiration_data", lambda g, d: g.get_respiration_data(d)),
    ("spo2_data", lambda g, d: g.get_spo2_data(d)),
    ("heart_rates", lambda g, d: g.get_heart_rates(d)),
    ("body_battery", lambda g, d: g.get_body_battery(d, d)),
]


def main():
    g = login()

    today = date.today()
    # Yesterday back DAYS days — today's recovery data is often incomplete.
    days = [str(today - timedelta(days=i)) for i in range(1, DAYS + 1)]

    dump = {"sampled_dates": days, "by_shape": {}}

    for key, fn in DATE_SHAPES:
        per_day = {}
        for d in days:
            try:
                per_day[d] = truncate_lists(fn(g, d))
            except Exception as e:
                per_day[d] = {"error": str(e)}
        dump["by_shape"][key] = per_day
        print(f"pulled {key}")

    with open(OUT_PATH, "w") as f:
        json.dump(dump, f, indent=2, default=str)
    print(f"\nWrote {OUT_PATH}")


if __name__ == "__main__":
    main()
