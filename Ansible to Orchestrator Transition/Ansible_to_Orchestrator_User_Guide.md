# Ansible to VCF Orchestrator Conversion — Spreadsheet User Guide

## Purpose

This guide explains how to use the **Ansible to Orchestrator Projects.xlsx** spreadsheet as your primary reference when converting Ansible playbooks into VCF Orchestrator workflows. Every row in the spreadsheet represents a single conversion project. Everything you need to understand what the Ansible playbook does, what files it depends on, and what inputs it expects is contained in this one file.

---

## Location
The spreadsheet is named **Ansible to Orchestrator Projectx.xlsx** and is located on the **VMware Team** >> General channel on the **Shared** tab under the General >> Projects >> Automation >> CONUS folder

## Who This Is For

Anyone assisting with the conversion of CONUS Ansible playbooks into Orchestrator workflows

---

## How the Spreadsheet Is Organized

Rows are sorted by **priority rank** (column A), which is based on how frequently each playbook has been executed in production. The most critical automations — the ones that run hundreds of times — are at the top. Low-priority items that have never run are at the bottom.

---

## Column-by-Column Reference

### A —  Rank

A number from 1 to 64 indicating conversion priority. Rank 1 is the most important (highest usage). Work top-down unless otherwise directed.


### B — Priority

A label derived from execution volume:

- **Critical** — Top 4 playbooks. These account for roughly 60% of all automation runs. Convert these first.
- **High** — Next tier. These are regularly used and should be converted early.
- **Medium** — Moderate usage. Convert after Critical and High items are done.
- **Low** — Zero or near-zero executions. These may be candidates for retirement rather than conversion.

### C — Playbook Name

The filename of the Ansible playbook. If it contains a path separator (e.g., `nexus_upgrades/staging-with-scp.yml`), the playbook lives in a subfolder within the repository. Otherwise, it's at the repository root.

### D — What It Does

A plain-language summary of what the playbook accomplishes. Read this first when starting a new conversion project. This tells you what the Orchestrator workflow needs to replicate.

### E — # Times Ran

Total execution count from the Ansible Automation Platform. Higher numbers mean more operational reliance and higher stakes if the conversion introduces bugs.

### F — Assigned To

Who is responsible for converting this playbook. Your name goes here once a project is assigned to you.

### G — Status

Current conversion status. Update this as you work: Not Started, In Progress - Code Analysis, In Progress, Testing, Complete, On Hold, Retired, etc.

### H — Status Comments

Details regarding the current status, e.g. Status = In Progress, Status Comments = Code Analysis, Code Development, Building out testing environment, etc...

### I — Teams Folder

The Teams folder name where all project documentation is to reside.  The base path is the VMware Team >> General Channel >> Shared tab >> Project >> Automation >> CONUS.  The Teams Folder name represents the copied GIT repository (located at <base path> >> Ansible Playbooks from GitHub) as well as the project folder where all code, workflows, and documentation are to be stored (located at <base path> >> Automation Projects).

### J — Complexity
A T-shirt size (S/M/L/XL) indicating how complex the conversion is. A simple `dnf upgrade -y` is Small; a multi-role STIG playbook with 200+ tasks is XL. This helps with planning and setting expectations.

### K — Notes / Gotchas
**Notes / Gotchas** — A free-text column for conversion-specific warnings (e.g., "This playbook dynamically builds its inventory from AD — Orchestrator will need a different approach" or "The PowerShell script is 500+ lines; consider breaking into multiple scriptable tasks").

### L — Ansible Job Name

The name(s) of the Ansible Automation Platform (AAP) job template(s) that use this playbook. A single playbook often has multiple job templates — each one targets a different environment or passes different input variables. Think of these as different "configurations" of the same automation. In the Orchestrator world, you'll likely create one workflow and use different input forms or input parameters to replicate this pattern.

### M — Authentication Type

How the playbook authenticates to its targets. This is critical for the Orchestrator conversion because you'll need to configure equivalent credentials in VCF:

- **domain service account** — Windows Active Directory service account. In Orchestrator, you'll use a PowerShell or WinRM host with stored credentials.
- **ssh** — SSH key-based or password authentication to Linux/network hosts. In Orchestrator, you'll configure SSH endpoint connections.
- **ssh, gitlab** — SSH to devices plus GitLab API access. The Orchestrator workflow will need both an SSH connection and a REST endpoint for the Git server.
- **cisco cli** — Cisco CLI access (often over SSH). Same SSH mechanism in Orchestrator.
- **root (prompted)** — Root credentials entered at runtime. In Orchestrator, this maps to a workflow input that accepts credentials.
- **vCenter service account** — A vCenter-specific service account. Orchestrator has native vCenter plugin connections for this.

### N — Ansible Inventory

The inventory group or host list that the playbook targets. This tells you which systems the Orchestrator workflow will need to talk to. In Orchestrator, targets are defined either as workflow inputs or as connections configured in the Orchestrator client.

### O - Target OS / Platform
A column indicating whether the target is Windows, RHEL, SLES, Cisco NX-OS, vCenter/ESXi, or Aria. This helps the converter know which Orchestrator plugin/connection type to use before even reading the playbook.

### P - Orchestrator Connection Type Needed
A prescriptive column mapping each playbook to the Orchestrator connection type they should configure: "PowerShell Host," "SSH Connection," "vCenter Plugin," "REST Host," etc.

### Q — External File Dependencies

Whether the playbook depends on files beyond itself. This is one of the most important columns for your conversion work. The possible values are:

- **No** — The playbook is self-contained. All logic is inline. Your Orchestrator workflow just needs to replicate the logic.
- **Yes — Role: roles/\<name\>/** — The playbook calls an Ansible "role," which is a folder containing multiple task files, variable defaults, handlers, and templates. You'll need to read through the entire role directory to understand all the steps. These are the most complex conversions.
- **Yes — Files: files/\<path\>** — The playbook copies and executes an external script file (usually PowerShell). You'll need to examine that script to understand what it does. In Orchestrator, this script logic will need to be embedded in a scriptable task or called via a PowerShell host.
- **Yes — Task file: tasks/\<name\>.yml** — The playbook includes a shared task file. Read it alongside the main playbook.
- **Yes — Companion playbooks** — Other playbooks that work together (e.g., backup/diff/restore). These may become a single multi-branch Orchestrator workflow or separate linked workflows.
- **Yes — External file on remote server** — The playbook pulls a file from an external server at runtime (firmware images, etc.).
- **Yes — Git repo** — The playbook interacts with a Git repository for config storage/retrieval.

### R — Repository File Paths

The full file paths to the playbook and all its dependencies within the downloaded Git repositories. This tells you exactly where to find every file you need to read. The format is:

```
Playbook: <repo-folder>/<playbook-path>
Role: <repo-folder>/roles/<role-name>/
File: <repo-folder>/files/<script-path>
Task: <repo-folder>/tasks/<task-file>
Config: <repo-folder>/config/<config-file>
Companion: <repo-folder>/<companion-playbook>
External: <description of external resource>
```

For example, for the ESXi STIG playbook you'll see:

```
Playbook: esxi-stig/esxi-stig.yml
Role: esxi-stig/roles/vsphere_stig_security/
Role: esxi-stig/roles/vsphere_stig_logging/
Role: esxi-stig/roles/vsphere_stig_services/
Role: esxi-stig/roles/vsphere_stig_reporting/
Config: esxi-stig/config/production_stig_config.yml
```

This means you need to read the main playbook plus four role directories plus a config file — all under the `esxi-stig/` folder.







### S through AB — AAP Template 1–10

Each of these columns represents one Ansible Automation Platform job template that uses this playbook. The cell contains:

1. **The template name** (first line) — e.g., `1P_EMAT_Server_Reboot_GP02`
2. **extra_vars** (remaining lines, if present) — The input variables passed to the playbook for this specific template. These are the values that change between templates.

**Why this matters for Orchestrator:** Each template is essentially the same workflow run with different inputs. When you build the Orchestrator workflow, you'll create input parameters that match these extra_vars. The different templates show you the range of values those inputs will need to accept.

For example, if you see three templates for a reboot playbook, each with a different `var_ADGroupMember` value, your Orchestrator workflow needs a single input parameter called something like "AD Group" that accepts different group names.

---

## Suggested Workflow for Each Conversion Project

1. **Read column D** (What It Does) to understand the automation's purpose.
2. **Check column M** (External File Dependencies) and **column N** (Repository File Paths) to identify all source files you need to review.
3. **Open the playbook file** from the repository path in column N. Read through it top to bottom.
4. **If there are roles or external scripts**, open those too. Roles contain the actual step-by-step logic.  Roles are referenced in the main ansible playbook.  The main ansible playbook is like the entry point to the entire automation process.
5. **Review the AAP Templates** (columns O–X) to understand the input variables and their typical values.
6. **Check column G** (Authentication Type) to determine what Orchestrator connections/credentials you'll need.
7. **Build the Orchestrator workflow**, mapping Ansible tasks to Orchestrator scriptable tasks, and Ansible extra_vars to Orchestrator workflow inputs.
8. **Update columns G and H** (Status) as you progress.

---

## Key Ansible Concepts (Quick Reference)

If you're new to Ansible, here's the minimum you need to understand to read a playbook:

- **Playbook** — A YAML file that defines a sequence of automated steps ("tasks") to run on remote hosts.
- **Task** — A single step, like "copy this file," "run this command," or "restart this service."
- **Module** — The Ansible built-in function that a task calls (e.g., `win_shell`, `cisco.nxos.nxos_config`, `community.vmware.vmware_guest_snapshot`). This tells you what type of action is being performed.
- **Role** — A reusable, structured bundle of tasks, variables, templates, and handlers in a folder hierarchy. Think of it as a "function library."
- **extra_vars** — Input variables passed to the playbook at runtime. These are the equivalent of Orchestrator workflow input parameters.
- **Inventory** — The list of target hosts. In Orchestrator, targets are defined through connections or input parameters.
- **Handler** — A task that only runs when "notified" by another task (e.g., "restart the service only if the config file changed").
- **Template (Jinja2)** — A file with `{{ variable }}` placeholders that gets filled in at runtime. You'll see these as `.j2` files in roles.
- **Register** — Captures the output of a task into a variable for use in later tasks.
- **When** — A conditional that controls whether a task runs (e.g., `when: ansible_os_family == "RedHat"`).