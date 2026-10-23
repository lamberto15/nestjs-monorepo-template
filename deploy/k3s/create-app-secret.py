#!/usr/bin/env python3
"""Create the lab01 app Secret without putting credentials in shell arguments.

Run interactively on lab01 after postgres-secrets and redis-secrets exist. Save
the generated values in a password manager before confirming the prompt.
"""

import base64
import getpass
import json
import secrets
import subprocess
import sys
from urllib.parse import quote


NAMESPACE = "nestjs-monorepo"
KUBECTL = ["sudo", "k3s", "kubectl", "-n", NAMESPACE]


def kubectl(*args: str, data: str | None = None) -> str:
    result = subprocess.run(
        [*KUBECTL, *args],
        input=data,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "kubectl failed")
    return result.stdout


def main() -> int:
    try:
        existing = json.loads(
            kubectl("get", "secrets", "postgres-secrets", "redis-secrets", "-o", "json")
        )
        secret_data = {item["metadata"]["name"]: item["data"] for item in existing["items"]}
        owner_password = base64.b64decode(secret_data["postgres-secrets"]["postgres_password"]).decode()
        redis_password = base64.b64decode(secret_data["redis-secrets"]["redis_password"]).decode()
        if not owner_password or not redis_password:
            raise ValueError("database and Redis passwords must be nonempty")

        mail_api_key = getpass.getpass("Resend API key: ")
        if not mail_api_key:
            raise ValueError("Resend API key must be nonempty")

        generated = {
            "app_runtime password": secrets.token_hex(32),
            "app_maintenance password": secrets.token_hex(32),
            "JWT secret": secrets.token_hex(32),
            "MFA encryption key": base64.b64encode(secrets.token_bytes(32)).decode(),
            "data encryption key": base64.b64encode(secrets.token_bytes(32)).decode(),
            "blind index key": base64.b64encode(secrets.token_bytes(32)).decode(),
        }
        print("\nSave these six independent values in your password manager. Do not paste them into chat.\n")
        for label, value in generated.items():
            print(f"{label}: {value}")
        print()
        if input("After saving every value, type SAVED to create app-secrets: ") != "SAVED":
            print("No Secret was created.")
            return 1

        def database_url(role: str, password: str) -> str:
            return f"postgres://{role}:{quote(password, safe='')}@postgres:5432/app"

        data = {
            "database_owner_url": database_url("app", owner_password),
            "database_url": database_url("app_runtime", generated["app_runtime password"]),
            "database_maintenance_url": database_url(
                "app_maintenance", generated["app_maintenance password"]
            ),
            "redis_password": redis_password,
            "jwt_secret": generated["JWT secret"],
            "mfa_encryption_keys": generated["MFA encryption key"],
            "data_encryption_keys": generated["data encryption key"],
            "blind_index_keys": generated["blind index key"],
            "mail_api_key": mail_api_key,
        }
        manifest = {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "app-secrets", "namespace": NAMESPACE},
            "type": "Opaque",
            "stringData": data,
        }
        print(kubectl("create", "-f", "-", data=json.dumps(manifest)).strip())
        return 0
    except (KeyError, ValueError, RuntimeError) as exc:
        print(f"Setup stopped: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
