#!/usr/bin/env bash
set -euo pipefail

# Prepare a verona release: bump package.json + package-lock.json, regenerate
# CHANGELOG, commit, and tag. The release.yml workflow then handles npm publish
# + GitHub release on tag push.
#
# Usage:
#   ./scripts/release.sh 0.2.0
#
# After running:
#   git push origin main --tags

if [ $# -ne 1 ]; then
    echo "Usage: ./scripts/release.sh <version>" >&2
    echo "Example: ./scripts/release.sh 0.2.0" >&2
    exit 1
fi

VERSION="$1"
TAG="v${VERSION}"

# Validate semver (loose: major.minor.patch with optional -prerelease)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "Error: '$VERSION' is not a valid semver (expected major.minor.patch[-prerelease])" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Error: uncommitted changes detected. Commit or stash before releasing." >&2
    exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "Error: tag $TAG already exists." >&2
    exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
    echo "Warning: releasing from '$BRANCH', not 'main'." >&2
    read -r -p "Continue? [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || exit 1
fi

PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"

echo "Preparing release ${TAG}..."
echo ""

# 1. Bump version in package.json + package-lock.json
echo "Bumping version to ${VERSION}..."
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

# 2. Verify build pipeline succeeds before tagging
echo "Running typecheck..."
npm run typecheck

echo "Running tests..."
npm test

echo "Running build..."
npm run build
echo "Build verified."
echo ""

# 3. Generate CHANGELOG entry
CHANGELOG_FILE="$ROOT/CHANGELOG.md"
RELEASE_DATE="$(date -u +%Y-%m-%d)"

if [ -n "$PREV_TAG" ]; then
    HEADER_LINE="### Changes since ${PREV_TAG}"
    COMMITS="$(git log "${PREV_TAG}..HEAD" --pretty=format:"- %s" --no-merges)"
else
    HEADER_LINE="### Changes"
    COMMITS="$(git log --pretty=format:"- %s" --no-merges)"
fi

ENTRY="$(printf "## %s\n\n**Released:** %s\n\n%s\n\n%s\n" \
    "$TAG" "$RELEASE_DATE" "$HEADER_LINE" "$COMMITS")"

if [ -f "$CHANGELOG_FILE" ]; then
    REST="$(tail -n +2 "$CHANGELOG_FILE")"
    {
        echo "# Changelog"
        echo
        echo "$ENTRY"
        echo "$REST"
    } > "$CHANGELOG_FILE"
else
    {
        echo "# Changelog"
        echo
        echo "$ENTRY"
    } > "$CHANGELOG_FILE"
fi

echo "Updated CHANGELOG.md"
echo ""

# 4. Commit + annotated tag
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"

echo ""
echo "Release ${TAG} prepared."
echo ""
echo "Next:"
echo "  git push origin main --tags"
echo ""
echo "Then watch the publish + GitHub release at:"
echo "  https://github.com/blake-simpson/verona/actions"
