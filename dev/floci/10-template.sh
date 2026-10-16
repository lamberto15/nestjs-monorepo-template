#!/bin/sh
# Floci's ready hook (compose.dev.yaml, profile `aws`): what the app expects to
# find on AWS. Safe to run on every start.
set -eu

aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null ||
  aws s3api create-bucket --bucket "$S3_BUCKET"

# SES sends only from verified identities.
aws ses verify-email-identity --email-address "$MAIL_FROM_ADDRESS"
