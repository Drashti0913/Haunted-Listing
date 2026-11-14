#!/usr/bin/env bash
# Deploy Haunted Listing to AWS App Runner (public HTTPS URL).
# Needs: AWS CLI v2 configured (`aws configure`), Docker Desktop running, and a .env file.
# Re-run any time to ship a new version.
set -euo pipefail

APP="${APP:-haunted-listing}"
REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
REGION="${REGION:-us-east-1}"
cd "$(dirname "$0")/.."

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$APP"
echo "==> Account $ACCOUNT, region $REGION"

echo "==> ECR repository"
aws ecr describe-repositories --repository-names "$APP" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$APP" --region "$REGION" >/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

echo "==> Build and push image (linux/amd64)"
docker buildx build --platform linux/amd64 -t "$REPO:latest" --push .

echo "==> IAM role that lets App Runner pull from ECR"
ROLE=AppRunnerECRAccessRole
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow",
    "Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
  sleep 10   # let IAM propagate
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

echo "==> One instance only (games live in memory)"
ASC_ARN=$(aws apprunner list-auto-scaling-configurations --region "$REGION" \
  --auto-scaling-configuration-name "$APP-single" --query 'AutoScalingConfigurationSummaryList[0].AutoScalingConfigurationArn' --output text)
if [ "$ASC_ARN" = "None" ] || [ -z "$ASC_ARN" ]; then
  ASC_ARN=$(aws apprunner create-auto-scaling-configuration --region "$REGION" \
    --auto-scaling-configuration-name "$APP-single" --max-concurrency 100 --min-size 1 --max-size 1 \
    --query AutoScalingConfiguration.AutoScalingConfigurationArn --output text)
fi

# Environment variables for the container come from .env (non-empty values only).
SOURCE_JSON=$(python3 - "$REPO" "$ROLE_ARN" <<'PY'
import json, sys, pathlib
repo, role = sys.argv[1], sys.argv[2]
env = {}
p = pathlib.Path(".env")
if p.exists():
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            if v.strip():
                env[k.strip()] = v.strip()
print(json.dumps({
    "ImageRepository": {
        "ImageIdentifier": f"{repo}:latest",
        "ImageRepositoryType": "ECR",
        "ImageConfiguration": {"Port": "8080", "RuntimeEnvironmentVariables": env},
    },
    "AutoDeploymentsEnabled": False,
    "AuthenticationConfiguration": {"AccessRoleArn": role},
}))
PY
)

SERVICE_ARN=$(aws apprunner list-services --region "$REGION" \
  --query "ServiceSummaryList[?ServiceName=='$APP'].ServiceArn | [0]" --output text)

if [ "$SERVICE_ARN" = "None" ] || [ -z "$SERVICE_ARN" ]; then
  echo "==> Creating App Runner service (takes ~5 minutes)"
  SERVICE_ARN=$(aws apprunner create-service --region "$REGION" --service-name "$APP" \
    --source-configuration "$SOURCE_JSON" \
    --instance-configuration Cpu=1024,Memory=2048 \
    --auto-scaling-configuration-arn "$ASC_ARN" \
    --health-check-configuration Protocol=HTTP,Path=/api/health \
    --query Service.ServiceArn --output text)
else
  echo "==> Updating App Runner service"
  aws apprunner update-service --region "$REGION" --service-arn "$SERVICE_ARN" \
    --source-configuration "$SOURCE_JSON" >/dev/null
fi

echo "==> Waiting for the service to be RUNNING"
for _ in $(seq 1 60); do
  STATUS=$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query Service.Status --output text)
  [ "$STATUS" = "RUNNING" ] && break
  [ "$STATUS" = "CREATE_FAILED" ] && { echo "Create failed, check the App Runner console logs"; exit 1; }
  sleep 10
done
URL=$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query Service.ServiceUrl --output text)
echo
echo "Live at: https://$URL"
