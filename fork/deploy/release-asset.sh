#!/bin/bash
# release-asset.sh — GitHub Release asset upload/download for rollback tarballs.
# Usage:
#   release-asset.sh upload <tag> <tarball>     # gh release create, sha256 in notes
#   release-asset.sh download <tag> <dest-dir>  # download + sha256 verify vs notes
# Dry run: DRY_RUN=1 prints the gh commands without running them.
# Never prints secrets; the sha256 travels in the public release notes.
set -u

REPO="ftdaily/OmniRoute"

usage() {
  echo "usage: release-asset.sh upload <tag> <tarball> | download <tag> <dest-dir>" >&2
  exit 2
}

run() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "+ $*"
    return 0
  fi
  "$@"
}

cmd_upload() {
  [ $# -eq 2 ] || usage
  tag="$1"; tarball="$2"
  [ -f "$tarball" ] || { echo "release-asset: no such file: $tarball" >&2; exit 1; }
  sha=$(sha256sum "$tarball" | awk '{print $1}')
  run gh release create "$tag" "$tarball" -R "$REPO" --notes "sha256: $sha"
}

cmd_download() {
  [ $# -eq 2 ] || usage
  tag="$1"; dest="$2"
  mkdir -p "$dest"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "+ gh release download $tag -R $REPO -D $dest"
    echo "+ sha256sum verify vs release notes"
    return 0
  fi
  run gh release download "$tag" -R "$REPO" -D "$dest"
  notes=$(gh release view "$tag" -R "$REPO" --json body -q .body)
  expected=$(printf '%s' "$notes" | grep -oE '[0-9a-f]{64}' | head -1)
  [ -n "$expected" ] || { echo "release-asset: no sha256 in notes for $tag" >&2; exit 1; }
  for f in "$dest"/*; do
    actual=$(sha256sum "$f" | awk '{print $1}')
    if [ "$actual" = "$expected" ]; then
      echo "verified: $f"
      return 0
    fi
  done
  echo "release-asset: sha256 mismatch for $tag (expected $expected)" >&2
  exit 1
}

[ $# -ge 1 ] || usage
cmd="$1"; shift
case "$cmd" in
  upload) cmd_upload "$@" ;;
  download) cmd_download "$@" ;;
  *) usage ;;
esac
