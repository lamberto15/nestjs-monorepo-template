FROM caddy:2.11-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.11
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# The Cloudflare token from the environment or a file (a Docker secret).
COPY --chmod=755 entrypoint.sh /usr/local/bin/caddy-entrypoint
ENTRYPOINT ["caddy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
