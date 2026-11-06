#!/usr/bin/env bash
# Creates the public demo's GCP resources once (approved by Rohit, 5 Nov 2026): its own network (web from anywhere,
# SSH only from Google's IAP range; the project's default network and its open rules are not used), a static IP, a
# 10 GB data disk with daily snapshots kept 7 days, and the VM with the Vertex-only service account attached (no key
# files). Each step skips what already exists. Prints the IP for the DNS record.
set -euo pipefail
cd "$(dirname "$0")"
. ./config.sh

exists() { "$@" >/dev/null 2>&1; }

exists G compute networks describe "$NETWORK" || G compute networks create "$NETWORK" --subnet-mode=custom
exists G compute networks subnets describe "$SUBNET" --region="$REGION" || G compute networks subnets create "$SUBNET" --network="$NETWORK" --region="$REGION" --range="$SUBNET_RANGE"
exists G compute firewall-rules describe likeness-allow-web || G compute firewall-rules create likeness-allow-web --network="$NETWORK" --direction=INGRESS --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=likeness-web
# SSH only through IAP (Google's documented range for TCP forwarding).
exists G compute firewall-rules describe likeness-allow-iap-ssh || G compute firewall-rules create likeness-allow-iap-ssh --network="$NETWORK" --direction=INGRESS --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=likeness-web

exists G compute addresses describe "$ADDRESS" --region="$REGION" || G compute addresses create "$ADDRESS" --region="$REGION"
IP=$(G compute addresses describe "$ADDRESS" --region="$REGION" --format='value(address)')

exists G compute disks describe "$DATA_DISK" --zone="$ZONE" || G compute disks create "$DATA_DISK" --zone="$ZONE" --size=10GB --type=pd-balanced
exists G compute resource-policies describe "$SNAPSHOTS" --region="$REGION" || G compute resource-policies create snapshot-schedule "$SNAPSHOTS" --region="$REGION" --daily-schedule --start-time=21:30 --max-retention-days=7 --on-source-disk-delete=keep-auto-snapshots
G compute disks describe "$DATA_DISK" --zone="$ZONE" --format='value(resourcePolicies)' | grep -q "$SNAPSHOTS" || G compute disks add-resource-policies "$DATA_DISK" --zone="$ZONE" --resource-policies="$SNAPSHOTS"

exists G compute instances describe "$VM" --zone="$ZONE" || G compute instances create "$VM" \
  --zone="$ZONE" --machine-type="$MACHINE" \
  --network-interface="subnet=$SUBNET,address=$IP" \
  --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=20GB --boot-disk-type=pd-balanced \
  --disk="name=$DATA_DISK,device-name=$DATA_DISK,mode=rw,auto-delete=no" \
  --service-account="$SERVICE_ACCOUNT" --scopes=cloud-platform \
  --tags=likeness-web --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata=enable-oslogin=TRUE

echo "VM $VM in $ZONE, static IP $IP"
echo "DNS (Vercel, facevisa.site): A records for facevisa.site and www, value $IP"
