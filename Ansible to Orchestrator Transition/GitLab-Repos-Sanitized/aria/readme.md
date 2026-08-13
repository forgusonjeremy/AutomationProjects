# VMware Aria 8.18 Firewall Configuration v2.4
## FINAL PRODUCTION VERSION - With Catch-All DROP Rules

## What's New in v2.4

### Major Security Enhancement: Catch-All DROP Rules
- ✅ **Adds catch-all DROP at end of TCP chain** (blocks all unlisted TCP ports)
- ✅ **Adds catch-all DROP at end of UDP chain** (blocks all unlisted UDP ports)
- ✅ **Prevents security scanner discovery** (SSL certificates no longer visible)
- ✅ **Future-proof security** (new ports automatically blocked)
- ✅ **Best practice implementation** (whitelist approach)

### How It Works

**Before v2.4:**
```
Unlisted port (e.g., 1514):
→ No rule in TCP chain
→ Returns to INPUT chain
→ Falls through to default DROP
→ BUT... ESTABLISHED state (INPUT line 7) might bypass!
→ Scanner can connect ❌
```

**After v2.4:**
```
Unlisted port (e.g., 1514):
→ No specific rule in TCP chain
→ Hits catch-all DROP at end of chain
→ Never returns to INPUT
→ Never reaches ESTABLISHED rule
→ Scanner cannot connect ✅
```

## Quick Start
```bash
ansible-playbook -i inventory.yml vmware_aria_firewall_preserve_v2.4.yml \
  -e "survey_restricted_ports=1514:tcp,1514:udp,6514:tcp,9543:tcp,443:tcp,8553:tcp,8443:tcp" \
  -e "survey_restricted_ports_ips=100.64.0.41,100.64.0.42,100.64.0.43,100.64.0.44" \
  -e "survey_cluster_nodes=100.64.0.41,100.64.0.42,100.64.0.43,100.64.0.44" \
  -e "survey_remove_existing_blocks=true"
```

## Expected Results

### TCP Chain (After v2.4):
```
Chain TCP (1 references)
1. ACCEPT  127.0.0.0/8 → 8553      (localhost only)
2. DROP    0.0.0.0/0   → 8553      (block all others)
3. ACCEPT  0.0.0.0/0   → 22        (SSH)
4. ACCEPT  0.0.0.0/0   → 4505      (Salt Master)
5. ACCEPT  0.0.0.0/0   → 4506      (Salt Minion)
6. DROP    0.0.0.0/0   → 0.0.0.0/0 (CATCH-ALL - blocks everything else!) ✅
```

**Security impact:**
- ✅ Ports 1514, 6514, 8443, 9543, 443: **Automatically blocked by catch-all**
- ✅ Future ports: **Automatically blocked by catch-all**
- ✅ No need to add individual DROP rules per port
- ✅ Security scanner cannot discover SSL certificates

### UDP Chain (After v2.4):
```
Chain UDP (1 references)
1. ACCEPT  0.0.0.0/0   → 123       (NTP)
2. DROP    0.0.0.0/0   → 0.0.0.0/0 (CATCH-ALL - blocks everything else!) ✅
```

**Security impact:**
- ✅ Port 1514 UDP: **Automatically blocked by catch-all**
- ✅ All other UDP ports: **Automatically blocked by catch-all**

## Verification
```bash
# Check TCP chain has catch-all DROP
iptables -L TCP -n -v --line-numbers | tail -3
# Last line should show: DROP all -- 0.0.0.0/0 0.0.0.0/0

# Check UDP chain has catch-all DROP
iptables -L UDP -n -v --line-numbers | tail -3
# Last line should show: DROP all -- 0.0.0.0/0 0.0.0.0/0

# Test from unauthorized IP
nc -zv 100.64.0.41 1514   # Should fail
nc -zv 100.64.0.41 6514   # Should fail
nc -zv 100.64.0.41 8443   # Should fail

# Watch catch-all counters increase
watch -n 2 'iptables -L TCP -n -v | tail -1'
# Packet count should increase when scanner tries
```

## Security Scanner Remediation

**Before v2.4:**
- ⚠️ Vulnerability: SSL Self-Signed Certificate
- ⚠️ Ports: 8553, 6514, 1514
- ⚠️ Scanner can discover certificates

**After v2.4:**
- ✅ Ports completely blocked (no TCP connection possible)
- ✅ Scanner cannot complete TLS handshake
- ✅ No certificate discovery possible
- ✅ Vulnerability should disappear on next scan

## Version History

- **v2.4** (Current - FINAL PRODUCTION) ⭐
  - Added catch-all DROP rules to TCP/UDP chains
  - Prevents security scanner certificate discovery
  - Future-proof automatic blocking
  - Best practice whitelist approach
  
- **v2.3** - Fixed AWK column bug
  - Corrected column detection ($9, $10)
  
- **v2.2** - Simplified (no per-port DROP rules)
  - ⚠️ Had AWK bug and no catch-all protection
  
- **v2.1** - Added TCP/UDP chain support
  
- **v2.0** - Simplified (removed VAMI, logging)

## Files Included

| File | Version |
|------|---------|
| `vmware_aria_firewall_preserve_v2.4.yml` | **v2.4 (FINAL)** ⭐ |
| `survey_spec_v2.2.json` | v2.2 (still valid) |
| `inventory.yml` | v2.0 |
| `vmware_aria_firewall_rollback.yml` | v2.0 |
| `vmware_aria_firewall_validate.yml` | v2.0 |
| `README_v2.4.md` | **v2.4 (NEW)** |

## Comparison: All Versions

| Feature | v2.2 | v2.3 | v2.4 |
|---------|------|------|------|
| TCP/UDP chain cleaning | ✅ (broken AWK) | ✅ (fixed AWK) | ✅ (fixed AWK) |
| Catch-all DROP in chains | ❌ | ❌ | **✅ NEW** |
| Security scanner blocking | ❌ Partial | ❌ Partial | **✅ Complete** |
| Future-proof | ❌ | ❌ | **✅ Yes** |
| Best practice | ❌ | ❌ | **✅ Yes** |
| Production ready | ❌ | ⚠️ Partial | **✅ YES** ⭐ |

## Benefits of Catch-All Approach

| Benefit | Description |
|---------|-------------|
| **Automatic blocking** | New/unlisted ports automatically blocked |
| **No maintenance** | Don't need to add DROP rule for each port |
| **Scanner protection** | Prevents SSL certificate discovery |
| **Best practice** | Whitelist approach (industry standard) |
| **Future-proof** | VMware adds new port? Automatically blocked |
| **Simpler rules** | 1 catch-all vs many individual DROPs |

## Troubleshooting

### Catch-all not present
```bash
# Check if it exists
iptables -L TCP -n | tail -1 | grep "DROP.*all"

# If missing, add manually:
iptables -A TCP -j DROP -m comment --comment "Drop all other TCP traffic"
iptables -A UDP -j DROP -m comment --comment "Drop all other UDP traffic"

# Save
iptables-save > /etc/systemd/scripts/ip4save
```

### Security scanner still finds certificates
```bash
# Verify catch-all is blocking
iptables -L TCP -n -v | tail -1
# Packet count should increase when scanner runs

# Test manually
nc -zv 100.64.0.41 1514
# Should timeout/fail

# If still accessible, check for rules BEFORE catch-all
iptables -L TCP -n --line-numbers
```

## License

MIT

---

**v2.4 is the FINAL PRODUCTION-READY version!** ⭐

All issues resolved:
- ✅ TCP/UDP chain cleaning (fixed AWK)
- ✅ Catch-all DROP rules added
- ✅ Security scanner protection
- ✅ Future-proof automatic blocking
- ✅ Best practice implementation

**This version will eliminate the SSL certificate vulnerability by preventing the security scanner from connecting to restricted ports!**