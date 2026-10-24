#!/usr/bin/env python3
"""Create the optional R2 backup Secret without exposing keys in shell history."""

import getpass
import json
import secrets
import subprocess
import sys
from urllib.parse import urlparse


NAMESPACE = "nestjs-monorepo"
BUCKET = "nestjs-monorepo-backups"


def main() -> int:
    try:
        endpoint = input("R2 S3 endpoint (https://<account>.r2.cloudflarestorage.com): ").strip()
        parsed = urlparse(endpoint)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or not parsed.hostname.endswith(".r2.cloudflarestorage.com")
            or parsed.username
            or parsed.password
            or parsed.port
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("enter the exact HTTPS R2 S3 endpoint without a path")

        access_key_id = getpass.getpass("Bucket-scoped R2 Access Key ID: ")
        secret_access_key = getpass.getpass("Bucket-scoped R2 Secret Access Key: ")
        if not access_key_id or not secret_access_key:
            raise ValueError("both R2 keys are required")

        restic_password = secrets.token_urlsafe(48)
        print("\nSave this restic encryption password in your password manager. Do not paste it into chat.\n")
        print(f"restic encryption password: {restic_password}\n")
        if input("After saving it, type SAVED to create backup-secrets: ") != "SAVED":
            print("No Secret was created.")
            return 1

        manifest = {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "backup-secrets", "namespace": NAMESPACE},
            "type": "Opaque",
            "stringData": {
                "repository_base": f"s3:{endpoint.rstrip('/')}/{BUCKET}",
                "restic_password": restic_password,
                "access_key_id": access_key_id,
                "secret_access_key": secret_access_key,
            },
        }
        result = subprocess.run(
            ["sudo", "k3s", "kubectl", "-n", NAMESPACE, "create", "-f", "-"],
            input=json.dumps(manifest),
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "kubectl failed")
        print(result.stdout.strip())
        return 0
    except (ValueError, RuntimeError) as exc:
        print(f"Setup stopped: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
