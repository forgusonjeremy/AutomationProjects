# VMware vSphere 8.0 STIG Ansible Playbook Documentation

## Overview

This Ansible automation implements Security Technical Implementation Guide (STIG) compliance remediation for VMware vSphere 8.0 ESXi hosts. The playbook enforces DoD security standards and configurations across ESXi infrastructure.

## Architecture

### Main Playbook: `esxi-stig.yml`
The primary orchestration playbook that validates parameters, establishes connectivity, discovers target hosts, and executes STIG remediation roles.

### Configuration: `production_stig_config.yml`
Centralized security configuration defining all STIG control settings, security policies, and compliance parameters.

## Files Structure

```
├── esxi-stig.yml                    # Main playbook
├── config/
│   └── production_stig_config.yml   # STIG configuration
└── roles/
    ├── vsphere_stig_security/       # Security remediation role
    ├── vsphere_stig_logging/        # Logging configuration role
    ├── vsphere_stig_services/       # Services hardening role
    └── vsphere_stig_reporting/      # Compliance reporting role
```

## Prerequisites

### Required Collections
- `community.vmware` - VMware automation modules

### System Requirements
- Ansible 2.9+ with Python 3.6+
- Network connectivity to vCenter Server
- Administrative credentials for vCenter
- Target ESXi hosts must be managed by vCenter

### Required Permissions
- vCenter administrative access
- ESXi root or equivalent administrative access
- Permission to modify host configurations and services

## Variables

### Required Variables (Survey/Extra Vars)
| Variable | Description | Example |
|----------|-------------|---------|
| `vcenter_server` | vCenter Server FQDN/IP | `vcenter.example.com` |
| `vcenter_user` | vCenter username | `administrator@vsphere.local` |
| `vcenter_pass` | vCenter password | `SecurePassword123!` |
| `target_hostname` | Comma-separated ESXi hostnames | `esxi01.example.com,esxi02.example.com` |
| `target_cluster` | Target cluster name (alternative to hostnames) | `Production-Cluster` |

### Optional Infrastructure Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `syslog_host` | Syslog server for centralized logging | `''` (empty) |
| `ntp_server_list` | List of NTP servers | `[]` (empty list) |
| `esxi_admin_group` | ESXi admin group name | `root` |

### STIG Control Override Variables
Individual STIG controls can be disabled by setting corresponding variables to `false`:
- `enable_ESXI80000005` - Account lock failures (default: `true`)
- `enable_ESXI80000008` - Lockdown mode (default: `true`)
- `enable_ESXI80000193` - SSH service disabled (default: `true`)
- ... (see configuration file for complete list)

## STIG Controls Implemented

### Security Controls
- **ESXI-80-000005**: Account lockout after 3 failed attempts
- **ESXI-80-000008**: Normal lockdown mode enforcement
- **ESXI-80-000010**: Host client session timeout (900 seconds)
- **ESXI-80-000035**: Password complexity requirements
- **ESXI-80-000043**: Password history (5 passwords)
- **ESXI-80-000047**: Managed Object Browser (MOB) disabled
- **ESXI-80-000213**: Memory share force salting enabled
- **ESXI-80-000225**: Memory eager zero enabled

### Service Controls
- **ESXI-80-000193**: SSH service disabled
- **ESXI-80-000194**: ESXi Shell disabled
- **ESXI-80-000228**: CIM service disabled
- **ESXI-80-000231**: SLPD service disabled

### Logging Controls
- **ESXI-80-000015**: Log level set to 'info'
- **ESXI-80-000113**: Audit storage capacity (100MB)
- **ESXI-80-000114**: Syslog configuration
- **ESXI-80-000232**: Syslog audit logging enabled
- **ESXI-80-000233**: Remote syslog audit enabled

### Network Security Controls
- **ESXI-80-000215**: BPDU blocking enabled
- **ESXI-80-000216**: Forged transmits rejected
- **ESXI-80-000217**: MAC address changes rejected
- **ESXI-80-000218**: Promiscuous mode rejected

## Usage

### Basic Execution
```bash
ansible-playbook esxi-stig.yml \
  -e vcenter_server=vcenter.example.com \
  -e vcenter_user=administrator@vsphere.local \
  -e vcenter_pass=SecurePassword123! \
  -e target_hostname="esxi01.example.com,esxi02.example.com"
```

### Cluster-Based Execution
```bash
ansible-playbook esxi-stig.yml \
  -e vcenter_server=vcenter.example.com \
  -e vcenter_user=administrator@vsphere.local \
  -e vcenter_pass=SecurePassword123! \
  -e target_cluster="Production-Cluster"
```

### With Infrastructure Services
```bash
ansible-playbook esxi-stig.yml \
  -e vcenter_server=vcenter.example.com \
  -e vcenter_user=administrator@vsphere.local \
  -e vcenter_pass=SecurePassword123! \
  -e target_hostname="esxi01.example.com" \
  -e syslog_host="syslog.example.com" \
  -e ntp_server_list='["ntp1.example.com","ntp2.example.com"]'
```

### Tag-Based Execution
Execute specific remediation categories:
```bash
# Security controls only
ansible-playbook esxi-stig.yml --tags security

# Logging configuration only
ansible-playbook esxi-stig.yml --tags logging

# Services hardening only
ansible-playbook esxi-stig.yml --tags services

# Generate compliance report only
ansible-playbook esxi-stig.yml --tags reporting
```

### Disabling Specific Controls
```bash
ansible-playbook esxi-stig.yml \
  -e vcenter_server=vcenter.example.com \
  -e vcenter_user=administrator@vsphere.local \
  -e vcenter_pass=SecurePassword123! \
  -e target_hostname="esxi01.example.com" \
  -e enable_ESXI80000008=false \
  -e enable_ESXI80000193=false
```

## Playbook Execution Flow

### 1. Parameter Validation
- Validates required vCenter connection parameters
- Ensures target specification (hostname list or cluster)
- Loads STIG configuration from `production_stig_config.yml`
- Verifies configuration completeness

### 2. vCenter Connectivity
- Tests connection to vCenter Server
- Retrieves vCenter information
- Fails fast if connectivity issues exist

### 3. Host Discovery
- **Cluster Mode**: Discovers all ESXi hosts in specified cluster
- **Hostname Mode**: Validates specified hostnames exist in vCenter
- Displays discovered hosts for confirmation

### 4. STIG Remediation Execution
- **Security Role**: Implements security controls and policies
- **Logging Role**: Configures audit and system logging
- **Services Role**: Hardens and disables unnecessary services
- **Reporting Role**: Generates compliance verification report

## Configuration Management

### Production Configuration
The `production_stig_config.yml` file defines production-ready STIG settings:

**Security Posture:**
- Account lockout: 3 failures, 900-second unlock time
- Password complexity with 15-character minimum
- Aggressive session timeouts (600-900 seconds)
- Normal lockdown mode enforced
- All non-essential services disabled

**Logging Configuration:**
- Info-level logging enabled
- Audit logging with 100MB capacity
- Remote syslog with SSL certificate validation
- Comprehensive audit trail requirements

**Network Security:**
- BPDU, MAC change, and promiscuous mode protections
- BMC network access disabled
- TLS profile set to NIST 2024 standards

## Error Handling

### Validation Failures
- Missing required parameters trigger immediate failure
- Configuration loading errors prevent execution
- vCenter connectivity issues stop playbook execution

### Execution Failures
- Individual control failures are logged but don't stop overall execution
- Role-level failures are captured in reporting
- Detailed error messages provided for troubleshooting

## Security Considerations

### Credential Management
- Use Ansible Vault for credential encryption
- Consider credential rotation procedures
- Implement least-privilege access principles

### Network Security
- SSL certificate validation disabled for flexibility (consider enabling)
- Lockdown mode prevents direct ESXi access
- Service disabling reduces attack surface

### Compliance Verification
- Reporting role generates compliance evidence
- Regular execution recommended for drift detection
- Version control configuration changes

## Maintenance and Updates

### Regular Tasks
- Review and update STIG configuration quarterly
- Test playbook in development environment before production
- Monitor ESXi logs for configuration drift
- Update VMware collection regularly

### Customization
- Modify `production_stig_config.yml` for environment-specific requirements
- Override individual controls via extra variables
- Extend roles for additional organizational policies

## Troubleshooting

### Common Issues
1. **vCenter Connectivity**: Verify network access and credentials
2. **Host Discovery**: Ensure hostnames match vCenter inventory
3. **Permission Errors**: Verify administrative access to ESXi hosts
4. **Configuration Loading**: Check YAML syntax in configuration files

### Debug Mode
Enable verbose output for troubleshooting:
```bash
ansible-playbook esxi-stig.yml -vvv
```

### Validation Commands
Test connectivity before full execution:
```bash
ansible-playbook esxi-stig.yml --check --diff
```

## Compliance and Auditing

This playbook implements VMware vSphere 8.0 STIG Version 1 Release 1 controls as published by DISA. Regular execution ensures continuous compliance with DoD security standards.

### Audit Trail
- All configuration changes are logged
- Compliance reporting provides evidence of implementation
- Version control maintains change history

### Risk Management
- Production configuration prioritizes security over convenience
- Service disabling may impact operational procedures
- Lockdown mode restricts direct ESXi management access