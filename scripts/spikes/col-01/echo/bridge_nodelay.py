#!/usr/bin/env python3
"""Spike-only copy of the guest helper's `bridge` byte pipe with TCP_NODELAY.

It tests the C-SPK-03 confounder: the production helper
(packages/backend/microsandbox/guest/smithers-guest.py, `bridge`) leaves Nagle
on, so a 4 KiB frame split into segments can wait for a delayed ACK. This copy
is identical except for setsockopt(TCP_NODELAY) on both sockets. The
production helper is not changed.

usage: bridge_nodelay.py LISTEN_PORT HOST_PORT
"""
import socket
import sys
import threading

HOST = "host.microsandbox.internal"


def pump(source, sink):
    try:
        while True:
            data = source()
            if not data:
                break
            sink(data)
    except OSError:
        pass


def serve(client, port):
    client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    try:
        upstream = socket.create_connection((HOST, port), timeout=10)
        upstream.settimeout(None)
        upstream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError:
        client.close()
        return

    def half(src, dst):
        pump(lambda: src.recv(65536), dst.sendall)
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    threading.Thread(target=half, args=(client, upstream), daemon=True).start()
    half(upstream, client)
    client.close()
    upstream.close()


def main():
    listen_port, host_port = int(sys.argv[1]), int(sys.argv[2])
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", listen_port))
    listener.listen(128)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client, host_port), daemon=True).start()


if __name__ == "__main__":
    main()
