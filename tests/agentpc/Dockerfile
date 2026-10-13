# Frischer Debian-13-"Agent-PC" mit systemd für den Installationstest (ohne Docker – das holt install.sh).
FROM debian:trixie
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update -q \
 && apt-get install -y -q --no-install-recommends systemd systemd-sysv dbus ca-certificates iproute2 xdg-user-dirs curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash agent \
 && mkdir -p /home/agent/Schreibtisch && chown agent:agent /home/agent/Schreibtisch
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
