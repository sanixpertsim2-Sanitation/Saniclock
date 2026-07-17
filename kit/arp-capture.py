#!/usr/bin/env python3
"""
arp-capture.py - intercept the NG-TC2's phone-home by ARP-spoofing the gateway,
then log exactly where it connects and how (DNS name, TCP port, TLS SNI, HTTP host).

Legitimate interop diagnostic on YOUR OWN device and network. It puts this PC
in the middle of the clock<->gateway path so we can observe (not decrypt) the
clock's cloud connection. Ctrl+C cleanly restores ARP tables.

Defaults: gateway 192.168.1.1, target clock 192.168.1.77.
Run in an Administrator PowerShell:  python C:\\arp-capture.py
"""
import sys, time, threading, re, datetime

try:
    from scapy.all import (ARP, Ether, srp, send, sniff, conf, get_if_hwaddr, getmacbyip)
except Exception as e:
    print("scapy not available:", e)
    print("Install it with:  pip install scapy")
    sys.exit(1)

GATEWAY = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.1"
TARGET  = sys.argv[2] if len(sys.argv) > 2 else "192.168.1.77"
LOGFILE = r"C:\capture-log.txt"

def stamp():
    return datetime.datetime.now().strftime("%H:%M:%S")

def log(msg):
    line = "[%s] %s" % (stamp(), msg)
    print(line, flush=True)
    try:
        with open(LOGFILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def get_mac(ip):
    try:
        m = getmacbyip(ip)
        if m:
            return m
    except Exception:
        pass
    ans, _ = srp(Ether(dst="ff:ff:ff:ff:ff:ff")/ARP(pdst=ip), timeout=3, retry=3, verbose=0)
    for _, r in ans:
        return r.hwsrc
    return None

def spoof(target_ip, target_mac, spoof_ip):
    send(ARP(op=2, pdst=target_ip, hwdst=target_mac, psrc=spoof_ip), verbose=0)

def restore(a_ip, a_mac, b_ip, b_mac):
    send(ARP(op=2, pdst=a_ip, hwdst=a_mac, psrc=b_ip, hwsrc=b_mac), count=5, verbose=0)
    send(ARP(op=2, pdst=b_ip, hwdst=b_mac, psrc=a_ip, hwsrc=a_mac), count=5, verbose=0)

running = True
def spoof_loop(t_mac, g_mac):
    while running:
        spoof(TARGET, t_mac, GATEWAY)     # tell clock: I am the gateway
        spoof(GATEWAY, g_mac, TARGET)     # tell gateway: I am the clock
        time.sleep(2)

def extract_sni(payload):
    # crude but reliable: find a hostname-looking token in the TLS ClientHello
    try:
        s = payload.decode("latin1", "ignore")
        for m in re.findall(r"[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?)+", s, re.I):
            host = m[0] if isinstance(m, tuple) else m
        hosts = re.findall(r"\b([a-z0-9][a-z0-9\-\.]{3,60}\.[a-z]{2,10})\b", s, re.I)
        return hosts[0] if hosts else None
    except Exception:
        return None

seen = set()
def handle(pkt):
    from scapy.all import IP, TCP, UDP, DNS, DNSQR, Raw
    if pkt.haslayer(DNS) and pkt.haslayer(DNSQR) and pkt.haslayer(IP):
        if pkt[IP].src == TARGET:
            q = pkt[DNSQR].qname.decode("latin1", "ignore").rstrip(".")
            log("DNS QUERY   clock asks to resolve  ->  %s" % q)
        return
    if pkt.haslayer(IP) and pkt.haslayer(TCP):
        ip, tcp = pkt[IP], pkt[TCP]
        if ip.src == TARGET and tcp.dport in (80, 443) and (tcp.flags & 0x02):  # SYN
            key = ("%s:%d" % (ip.dst, tcp.dport))
            if key not in seen:
                seen.add(key)
                proto = "HTTPS" if tcp.dport == 443 else "HTTP"
                log("*** CONNECT  clock -> %s:%d   (%s)  <=== THIS IS NGTECO'S ENDPOINT" % (ip.dst, tcp.dport, proto))
        if ip.src == TARGET and pkt.haslayer(Raw):
            data = bytes(pkt[Raw].load)
            if tcp.dport == 443 and len(data) > 5 and data[0] == 0x16:  # TLS handshake
                sni = extract_sni(data)
                log("    TLS ClientHello to %s:443   SNI/host hint: %s   => it's ENCRYPTED (HTTPS)" % (ip.dst, sni or "?"))
            elif tcp.dport == 80:
                head = data[:200].decode("latin1", "ignore").replace("\r", " ").replace("\n", " ")
                log("    HTTP request to %s:80   => PLAIN TEXT (crackable!):  %s" % (ip.dst, head))

def main():
    conf.verb = 0
    log("=== NG-TC2 ARP-spoof capture ===  gateway=%s  clock=%s" % (GATEWAY, TARGET))
    log("Resolving MAC addresses...")
    t_mac = get_mac(TARGET)
    g_mac = get_mac(GATEWAY)
    if not t_mac or not g_mac:
        log("Could not resolve MACs (clock_mac=%s gateway_mac=%s). Is the clock online?" % (t_mac, g_mac))
        return
    log("clock %s = %s   gateway %s = %s" % (TARGET, t_mac, GATEWAY, g_mac))
    log("Starting ARP spoof. NOW POWER-CYCLE THE CLOCK so it phones home.")
    log("Watching for its connection... (Ctrl+C to stop and restore)")
    th = threading.Thread(target=spoof_loop, args=(t_mac, g_mac), daemon=True)
    th.start()
    try:
        sniff(filter="host %s" % TARGET, prn=handle, store=0)
    except KeyboardInterrupt:
        pass
    finally:
        global running
        running = False
        time.sleep(0.3)
        log("Restoring ARP tables...")
        restore(TARGET, t_mac, GATEWAY, g_mac)
        log("Done. Full log saved to %s" % LOGFILE)

if __name__ == "__main__":
    main()
