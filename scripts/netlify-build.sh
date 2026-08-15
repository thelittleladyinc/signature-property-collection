#!/usr/bin/env bash
#
# Netlify build step for signaturepropertycollection.com.
#
# 2026-08-15 (Christine: "can you fix it then"). Until now Netlify ran no build
# at all -- it published the committed site/ folder as-is. That was chosen for a
# good reason ("nothing that can fail at deploy time"), but it has a nasty edge:
# editing build/build.py and pushing changed NOTHING on the live site, with no
# error anywhere to explain why. You had to remember to run the build locally and
# commit the regenerated site/ too. This script removes that trap.
#
# It deliberately distinguishes two kinds of failure, because they deserve
# opposite treatment:
#
#   1. The BUILD ENVIRONMENT can't run the generator at all -- no python3, no
#      pip, missing wheels. That is not a problem with the site's content, and
#      failing the deploy over it would block every future deploy including ones
#      that only touch netlify/functions or already-committed HTML. So: log it
#      loudly, publish the committed site/ (exactly today's behaviour), exit 0.
#
#   2. python3 RAN and build/build.py errored. That is a real defect in the
#      content or the generator, and publishing a half-written site/ over it
#      would be worse than not deploying. So: restore the committed site/ so a
#      partial write can't be published, then exit 1 to fail the deploy. Netlify
#      keeps serving the last good deploy and reports the failure, which is loud
#      in the right way.
#
# Net effect: never worse than the old no-build-step setup, and correct when the
# environment is healthy.
#
# PYTHON_BIN and BUILD_SCRIPT are overridable so the failure paths above can be
# exercised in a test rather than discovered in production.

set -uo pipefail   # NOT -e: every failure here is handled explicitly below.

PY="${PYTHON_BIN:-python3}"
BUILD="${BUILD_SCRIPT:-build/build.py}"
REQS="${REQS_FILE:-requirements.txt}"

echo "--- netlify-build: using PY=$PY BUILD=$BUILD"

# Restore site/ from git so a partial write can never reach the CDN. Best effort:
# outside a git checkout (or on a shallow clone missing the path) this is a no-op
# and the committed files on disk are already what we want.
restore_site() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git checkout -- site 2>/dev/null \
      && echo "    restored committed site/ from git" \
      || echo "    could not restore site/ from git (publishing whatever is on disk)"
  else
    echo "    not a git work tree; publishing site/ as committed"
  fi
}

# --- 1. Is the environment even capable of building? -------------------------
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "!! netlify-build: '$PY' not found in this build image."
  echo "!! Publishing the committed site/ unchanged -- same as the old"
  echo "!! no-build-step setup. Regenerate locally and commit site/ to update"
  echo "!! content, or set PYTHON_VERSION in Netlify so python3 is available."
  restore_site
  exit 0
fi

if [ ! -f "$BUILD" ]; then
  echo "!! netlify-build: $BUILD not found. Publishing committed site/."
  restore_site
  exit 0
fi

# --- 2. Dependencies. A failure here is environmental, not a content bug. ----
if [ -f "$REQS" ]; then
  if "$PY" -m pip install --quiet --disable-pip-version-check -r "$REQS"; then
    echo "--- netlify-build: dependencies installed"
  else
    echo "!! netlify-build: pip install failed. Trying the build anyway in case"
    echo "!! the dependencies are already present in the image."
  fi
fi

# --- 3. The actual build. A failure HERE is a real defect: fail the deploy. --
echo "--- netlify-build: regenerating site/ from $BUILD"
if "$PY" "$BUILD"; then
  echo "--- netlify-build: build OK, publishing freshly generated site/"
  exit 0
fi

echo "!! netlify-build: $BUILD FAILED."
echo "!! Not publishing a partially written site/. Restoring the committed"
echo "!! copy and failing this deploy so the last good deploy keeps serving."
restore_site
exit 1
