#!/bin/sh
# Consistent online SQLite backup (VACUUM INTO via the admin CLI) plus retention.
# Install as /usr/local/bin/missing-works-backup (root:root 0755); runs as missingworks.
set -eu
BACKUP_DIR="${BACKUP_DIR:-/var/backups/missing-works}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
/usr/local/bin/missing-works-admin backup "$BACKUP_DIR/votes-$stamp.sqlite"
# Keep RETENTION_DAYS of daily copies; never delete the newest one.
newest="$(ls -1t "$BACKUP_DIR"/votes-*.sqlite | head -n 1)"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'votes-*.sqlite' -mtime +"$RETENTION_DAYS" ! -path "$newest" -delete
