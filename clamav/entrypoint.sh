#!/bin/sh
# ClamAV for a read-only container (compose.clamav.yaml, service clamav).
#
# The image's /init needs root, capabilities and a writable image: it chowns
# the signatures, creates /run/clamav and edits /etc/clamav/*.conf with
# `sed -i` from CLAMD_CONF_* and FRESHCLAM_CONF_*. Its /init-unprivileged
# (docs.clamav.net, "Running ClamD using non-root user") does none of that,
# but it applies neither variable, and clamd and freshclam read
# /etc/clamav/*.conf unless given another file. So this does what
# /init-unprivileged does, after applying the same two variables to copies of
# the image's files in /tmp (--config-file), as the user `clamav`, who owns
# the signatures and nothing else.
#
#   CLAMD_CONF_<Name>=<value>       sets <Name> in clamd's configuration
#   FRESHCLAM_CONF_<Name>=<value>   the same in freshclam's
#   CLAMAV_NO_FRESHCLAMD=true       no freshclam daemon (the volume's signatures only)
#   FRESHCLAM_CHECKS=<n>            freshclam's update checks a day (default 1)
#
# Show the result without starting anything: entrypoint.sh --render
set -eu

# The paths can be changed for a test; the container uses the defaults.
etc=${CLAMAV_ETC:-/etc/clamav}
conf=${CLAMAV_CONF_DIR:-/tmp/clamav}
db=${CLAMAV_DB:-/var/lib/clamav}

mkdir -p "$conf"
cp "$etc/clamd.conf" "$etc/freshclam.conf" "$conf/"

# Every <prefix><Name>=<value> in the environment becomes "<Name> <value>" in
# <file>: the lines that set or comment <Name> go, the setting is appended.
apply() {
  prefix=$1
  file=$2
  env | while IFS='=' read -r key value; do
    case $key in
      "$prefix"?*) ;;
      *) continue ;;
    esac
    name=${key#"$prefix"}
    case $name in
      *[!A-Za-z0-9]*)
        echo "clamav: $key: '$name' is not a configuration option" >&2
        exit 1
        ;;
    esac
    # grep exits 1 when it keeps no line: that is not an error here.
    { grep -v -E "^#?$name( |\$)" "$file" || true; } >"$file.new"
    printf '%s %s\n' "$name" "$value" >>"$file.new"
    mv "$file.new" "$file"
  done
}
apply CLAMD_CONF_ "$conf/clamd.conf"
apply FRESHCLAM_CONF_ "$conf/freshclam.conf"

# freshclam tells clamd to reload the signatures through the socket that
# clamd.conf names: the copy this container's clamd reads.
sed -e "s|^NotifyClamd .*|NotifyClamd $conf/clamd.conf|" "$conf/freshclam.conf" >"$conf/freshclam.conf.new"
mv "$conf/freshclam.conf.new" "$conf/freshclam.conf"

if [ "${1:-}" = --render ]; then
  for file in clamd.conf freshclam.conf; do
    echo "# $file"
    grep -v -E '^(#|$)' "$conf/$file"
  done
  exit 0
fi

# The image ships a set of signatures and a new volume starts with it; clamd
# refuses to start without any.
if [ ! -f "$db/main.cvd" ] && [ ! -f "$db/main.cld" ]; then
  echo "Updating initial database"
  # No clamd to test the update against or to tell yet.
  sed -e 's|^\(TestDatabases \)|#\1|' -e '$a TestDatabases no' -e 's|^\(NotifyClamd \)|#\1|' \
    "$conf/freshclam.conf" >"$conf/freshclam-initial.conf"
  freshclam --foreground --stdout --config-file="$conf/freshclam-initial.conf"
fi

if [ "${CLAMAV_NO_FRESHCLAMD:-false}" != true ]; then
  echo "Starting Freshclamd"
  freshclam --checks="${FRESHCLAM_CHECKS:-1}" --daemon --foreground --stdout \
    --user=clamav --config-file="$conf/freshclam.conf" &
fi

echo "Starting ClamAV"
exec clamd --foreground --config-file="$conf/clamd.conf"
