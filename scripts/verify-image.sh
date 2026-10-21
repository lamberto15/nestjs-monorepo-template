#!/usr/bin/env bash
# Verifies the images CI published (docs/deployment.md, "Signing and
# verifying images"): the cosign signature (keyless, GitHub OIDC), the signed
# CycloneDX SBOM, and, when the gh CLI is installed, the SLSA build
# provenance. The signer must be this repository's ci.yml on main or a v* tag.
#
#   scripts/verify-image.sh [image...]    (default: APP_IMAGE, GOTENBERG_IMAGE
#                                          and CADDY_IMAGE, those that are set)
#
# VERIFY_IDENTITY_REGEXP overrides the accepted signer identity. The deploy
# scripts call this when VERIFY_IMAGES=1.
set -euo pipefail

images=("$@")
if [ ${#images[@]} -eq 0 ]; then
  for v in APP_IMAGE GOTENBERG_IMAGE CADDY_IMAGE; do
    [ -n "${!v:-}" ] && images+=("${!v}")
  done
fi
if [ ${#images[@]} -eq 0 ]; then
  echo "verify-image: no image given and none of APP_IMAGE, GOTENBERG_IMAGE, CADDY_IMAGE set" >&2
  exit 2
fi
command -v cosign >/dev/null 2>&1 || {
  echo "verify-image: cosign is not installed (https://docs.sigstore.dev/cosign/system_config/installation/)" >&2
  exit 2
}

issuer="https://token.actions.githubusercontent.com"
for image in "${images[@]}"; do
  # ghcr.io/<owner>/<repo>[/sub][:tag|@digest] -> <owner>/<repo>
  path=${image#ghcr.io/}
  slug=$(printf '%s' "$path" | cut -d/ -f1,2 | cut -d: -f1 | cut -d@ -f1)
  identity=${VERIFY_IDENTITY_REGEXP:-"^https://github\\.com/${slug//./\\.}/\\.github/workflows/ci\\.yml@refs/(heads/main|tags/v.+)$"}
  echo "verify-image: $image"
  cosign verify "$image" \
    --certificate-oidc-issuer "$issuer" \
    --certificate-identity-regexp "$identity" >/dev/null
  cosign verify-attestation "$image" --type cyclonedx \
    --certificate-oidc-issuer "$issuer" \
    --certificate-identity-regexp "$identity" >/dev/null
  if command -v gh >/dev/null 2>&1; then
    gh attestation verify "oci://$image" --owner "${slug%%/*}" >/dev/null
  else
    echo "verify-image: gh not installed, provenance not checked" >&2
  fi
done
echo "verify-image: all verified"
