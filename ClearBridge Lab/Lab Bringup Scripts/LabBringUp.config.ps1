# ===========================================================================
# LabBringUp.config.ps1
# Per-lab configuration. Dot-sourced by the dispatcher and both version
# scripts. EDIT THIS PER ENVIRONMENT. No logic here.
#
# NOTE: credentials are embedded in plaintext to match the existing lab model.
# For anything beyond an isolated lab, replace with SecretManagement / a
# credential file / DPAPI. See README "Operational considerations".
# ===========================================================================

# --- Paths -----------------------------------------------------------------
$ScriptDir = "C:\Lab-Initialization"
$LogDir    = Join-Path $ScriptDir "logs"
$MarkerFile = Join-Path $LogDir "Lab-Bringup-Complete.txt"

# --- Scheduled task (deleted on SUCCESS only) ------------------------------
$ScheduledTaskName = "\Lab-Power-On"

# --- ESXi (shared) ---------------------------------------------------------
$EsxiHosts = @(
  "esx-01a.site-a.vcf.lab",
  "esx-02a.site-a.vcf.lab",
  "esx-03a.site-a.vcf.lab",
  "esx-04a.site-a.vcf.lab"
)
$OptionalEsxiHost = "esx-05a.site-a.vcf.lab"   # VCF Automation gate
$EsxiUser         = "root"
$EsxiPassword     = "VMware123!VMware123!"

# --- vCenter / vSAN (shared) ----------------------------------------------
$VcenterServer   = "vc-mgmt-a.site-a.vcf.lab"
$VcenterUser     = "administrator@vsphere.local"
$VcenterPassword = "VMware123!VMware123!"
$VsanClusterNameContains = "mgmt-dc01"          # Substring match (case-insensitive). First cluster whose name contains this string is used.

# --- Timeouts / retries (shared) ------------------------------------------
$TcpPort                 = 443
$TcpTimeoutSec           = 3
$TcpRetryIntervalSec     = 10
$ViRetryIntervalSec      = 10
$ViOverallTimeoutSec     = 3600
$OptionalHostTcpWaitSec       = 120
$OptionalHostViConnectWaitSec = 180
$VcenterReadyTimeoutSec  = 1800
$VcenterReadyPollSec     = 10
$VcenterReadyMinRetrySec = 600
$VsanOnlineTimeoutSec    = 1200
$VsanOnlinePollSec       = 15
$PostPowerOnSleepSec     = 30
$AllGuestIpTimeoutSec    = 1800
$GuestIpPollSec          = 15

# 9.1 cluster readiness gate (Step 4): waits for all cluster hosts to be
# Connected + PoweredOn before issuing any Start-VM. Covers vCenter post-boot
# tasks: vSAN config, HA admission control, DRS init, system VMs, plugins.
$ClusterReadyTimeoutSec  = 1800   # 30 min ceiling; typically done in 5-10 min
$ClusterReadyPollSec     = 20

# 9.1 per-VM Start-VM retry (Step 5): retries transient scheduling errors
# (no host compatible, task failed) in place without restarting the script.
$StartVmRetryIntervalSec = 30
$StartVmTimeoutSec       = 600

# ===========================================================================
# 9.0-ONLY settings (FleetOps + VCF Installer)
# ===========================================================================
$fleetOpsUsername  = "admin@local"
$fleetOpsPassword  = "VMware123!VMware123!"
$fleetOpsFqdn      = "fleetops-a.site-a.vcf.lab"
$vcfAutomationFqdn = "auto-a.site-a.vcf.lab"

$VcfInstallerFqdn     = "vcfinstaller.site-a.vcf.lab"
$VcfInstallerPath     = "/vcf-installer-ui/login"
$VcfInstallerProbeSec = 30

# 9.0 post-vCenter boot plan (exact names, ordered)
$BootPlan90 = @(
  @{ Label="nsx-mgmt-01a";  Names=@("nsx-mgmt-01a") },
  @{ Label="fleetops-a";    Names=@("fleetops-a") },
  @{ Label="ops-a";         Names=@("ops-a") },
  @{ Label="opsproxy-01a";  Names=@("opsproxy-01a") },
  @{ Label="sddcmanager-a"; Names=@("sddcmanager-a") }
)

# ===========================================================================
# 9.1-ONLY settings
# ===========================================================================
# 9.1 post-vCenter boot plan (ordered).
#   Match: Exact | Prefix | Contains
#   RequiresEsx05    : step runs only if esx-05a confirmed present
#   RequireAtLeastOne: throw if no VM matches
$BootPlan91 = @(
  @{ Label="nsx-mgmt-01a"; Match="Exact";    Pattern="nsx-mgmt-01a"; RequiresEsx05=$false; RequireAtLeastOne=$true },
  @{ Label="ops-a";        Match="Exact";    Pattern="ops-a";        RequiresEsx05=$false; RequireAtLeastOne=$true },
  @{ Label="opsproxy-01a"; Match="Exact";    Pattern="opsproxy-01a"; RequiresEsx05=$false; RequireAtLeastOne=$true },
  @{ Label="sddcmanager-a";Match="Exact";    Pattern="sddcmanager-a";RequiresEsx05=$false; RequireAtLeastOne=$true },
  @{ Label="vcflic";       Match="Exact";    Pattern="vcflic";       RequiresEsx05=$false; RequireAtLeastOne=$true },
  @{ Label="vcfmgmtsvcs*"; Match="Prefix";   Pattern="vcfmgmtsvcs";  RequiresEsx05=$false; RequireAtLeastOne=$true },
  @{ Label="*auto*";       Match="Contains"; Pattern="auto";         RequiresEsx05=$true;  RequireAtLeastOne=$true }
)
