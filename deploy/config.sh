# The public demo's deployment: one e2-medium VM in likeness-eth (asia-south1), sourced by the other deploy scripts.
# Nothing secret here.
PROJECT=likeness-eth
GCLOUD_CONFIG=likeness-eth
REGION=asia-south1
ZONE=asia-south1-a
VM=likeness-web
MACHINE=e2-medium
NETWORK=likeness-net
SUBNET=likeness-subnet
SUBNET_RANGE=10.80.0.0/24
ADDRESS=likeness-web-ip
DATA_DISK=likeness-data
SNAPSHOTS=likeness-data-daily
SERVICE_ACCOUNT=likeness-vertex@likeness-eth.iam.gserviceaccount.com
DOMAIN=facevisa.site
# Names that redirect to https://$DOMAIN, keeping the path and query (old Verify and creator links keep working).
REDIRECT_DOMAINS="www.facevisa.site eth.likeness.site"

G() { gcloud --configuration="$GCLOUD_CONFIG" --project="$PROJECT" "$@"; }
# SSH and file copies only through Google's IAP tunnel: the VM has no public SSH.
vm_ssh() { G compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --quiet "$@"; }
