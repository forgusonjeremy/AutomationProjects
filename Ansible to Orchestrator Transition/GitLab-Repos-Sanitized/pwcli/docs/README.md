# VMware vSphere 8.0 STIG Configuration - Production Only

This repository contains configuration files and Ansible roles for implementing VMware vSphere 8.0 STIG (Security Technical Implementation Guide) compliance in production environments.

## Production Security Profile

This configuration implements **full STIG compliance** for production environments with:

- ✅ Account lockout and password policies enforced
- ✅ Strict session timeouts configured
- ✅ All unnecessary services disabled (SSH, Shell, CIM, SLPD)
- ✅ Lockdown mode enabled
- ✅ Full audit logging and syslog configured
- ✅ Memory and network security hardening
- ✅ SSL certificate validation enforced

## Usage in AAP

### Job Template Variables

```yaml
# Required Connection Details
vcenter_server: "vcenter.company.com"
vcenter_user: "{{ vault_vcenter_user }}"
vcenter_pass: "{{ vault_vcenter_pass }}"

# Target Configuration (choose one)
esxi_hostname: "dom1.dom2.example,dom3.dom2.example"  # Specific hosts
esxi_cluster: "Production-Cluster"                      # Entire cluster

# Repository Configuration
gitlab_config_repo: "https://dom4.dom2.example/infra/vsphere-stig-config.git"
config_branch: "v1.0.0"  # Use stable tags for production

# Infrastructure Settings
syslog_host: "udp://dom5.dom2.example:514"
ntp_server_list:
  - "dom6.dom2.example"
  - "dom7.dom2.example"
esxi_admin_group: "cn1"