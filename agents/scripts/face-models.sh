#!/bin/sh
# Downloads the local face matcher's models (VERIFICATION_LEVEL=free) into .models/ at the repo root (git-ignored; copied from likeness-meta scripts/face-models.sh @93993bc),
# pinned by sha256. Code: onnxruntime-node (MIT). Weights:
#  - YuNet face detector, OpenCV Zoo, MIT. https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
#    Caveat: trained on WIDER FACE, whose images are CC BY-NC-ND; the weights themselves are MIT.
#  - AuraFace v1 recognizer (glintr100.onnx only), fal, Apache-2.0. https://huggingface.co/fal/AuraFace-v1
#    fal: "trained on commercially and publicly available data sources"; the dataset is not named.
#    The other ONNX files in that repo are InsightFace copies (non-commercial) and are NOT downloaded.
#
#   cd agents && pnpm face:models
set -eu
dir="${FACE_MODELS_DIR:-../.models}"
mkdir -p "$dir"
# sha256sum on Linux, shasum on macOS
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
fetch() {
  url="$1"; out="$dir/$2"; want="$3"
  if [ -f "$out" ] && [ "$(sha256 "$out")" = "$want" ]; then echo "ok   $2"; return; fi
  echo "get  $2"
  curl -fL --retry 3 -o "$out.part" "$url"
  got="$(sha256 "$out.part")"
  if [ "$got" != "$want" ]; then rm -f "$out.part"; echo "sha256 mismatch for $2: $got" >&2; exit 1; fi
  mv "$out.part" "$out"
}
fetch https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx \
  face_detection_yunet_2023mar.onnx 8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
fetch https://huggingface.co/fal/AuraFace-v1/resolve/main/glintr100.onnx \
  auraface_glintr100.onnx a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60
echo "models in $dir"
