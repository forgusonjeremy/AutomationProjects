## File: `docs/STIG_CONTROLS.md`

```markdown
# VMware vSphere 8.0 STIG Controls Implementation

## Implemented Controls

### Security Controls
- **ESXI-80-000005**: Account Lock Failures
- **ESXI-80-000010**: Host Client Session Timeout  
- **ESXI-80-000015**: Log Level Configuration
- **ESXI-80-000035**: Password Complexity
- **ESXI-80-000043**: Password History
- **ESXI-80-000047**: Disable Managed Object Browser (MOB)
- **ESXI-80-000008**: Lockdown Mode

### Logging Controls
- **ESXI-80-000114**: Syslog Configuration
- **ESXI-80-000113**: Audit Record Storage
- **ESXI-80-000232**: Syslog Audit Enable
- **ESXI-80-000233**: Syslog Audit Remote
- **ESXI-80-000224**: SSL Certificate Checking

### Service Controls
- **ESXI-80-000124**: NTP Configuration
- **ESXI-80-000193**: SSH Service Management
- **ESXI-80-000194**: ESXi Shell Service Management

### Network/Memory Controls
- **ESXI-80-000213**: Memory Share Force Salting
- **ESXI-80-000225**: Memory Eager Zero
- **ESXI-80-000215**: Block Guest BPDU
- **ESXI-80-000250**: BMC Network Disable

## Control Categories

Controls are organized into logical groups for easier management:

1. **account_security**: Password policies, lockout settings
2. **session_timeouts**: Various timeout configurations
3. **memory_network_security**: Memory and network hardening
4. **disable_features**: Disable unnecessary features
5. **logging_config**: Basic logging configuration
6. **syslog_config**: Remote syslog configuration
7. **audit_logging**: Audit trail configuration
8. **ssl_cert_checking**: SSL certificate validation
9. **ntp_config**: Time synchronization
10. **ssh_service**: SSH access management
11. **shell_service**: Shell access management
12. **lockdown_mode**: Host lockdown enforcement

## Manual Controls

Some STIG controls require manual implementation:
- **ESXI-80-000049**: Active Directory integration
- **ESXI-80-000094**: Secure Boot configuration
- **ESXI-80-000198/199**: Traffic isolation (management/storage)
- **ESXI-80-000229**: DoD certificate installation