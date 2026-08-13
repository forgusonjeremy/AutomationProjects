# Variables that need to be set in the Ansible Template Variables
# Get-ServerPendingRebootStatus
---
var_ps_folder: 'ps_reports' # root folder of scripts
var_ps_script_file: 'cvs_report_script.ps1' # script to be execute
var_parameter_action: 'Get-ServerPendingRebootStatus' # parameter -Action
var_eMailReport: 'no' # parameter email configuration
var_SMTPServer: 'dom1.dom2.dom3.example' # parameter email configuration
var_MailToString: "user4@dom3.example,user4@dom3.example" # parameter email configuration 
var_MailCcString: "user4@dom3.example,user4@dom3.example" # parameter email configuration
var_MailSubjectstring: 'Ansible-Report: EMT Servers Reboot status' # parameter email configuration
var_cleanup_temporary_folder: true # parameter clean your crap after done
var_ADGroupMember: 'ESOC-Monitoring-Servers' # parameter security group of list of servers
var_HeaderNotesSubstr: "ESOC-Monitoring-Servers" # parameter note in part of the email body

# Variables that need to be set in the Ansible Template Variables
# Get-AllAdmin-Accounts
---
var_ps_folder: 'ps_reports' # root folder of scripts
var_ps_script_file: 'cvs_report_script.ps1' # script to be execute
var_parameter_action: 'Get-AllAdmin-Accounts' # parameter -Action
var_eMailReport: 'no' # parameter email configuration
var_SMTPServer: 'dom1.dom2.dom3.example' # parameter email configuration
var_MailToString: "user4@dom3.example,user4@dom3.example" # parameter email configuration 
var_MailCcString: "user4@dom3.example,user4@dom3.example" # parameter email configuration
var_MailSubjectstring: 'Ansible-Report: ESOC Admin PKI Card Status' # parameter email configuration
var_OUPath: 'OU=ou4,OU=ou5,OU=ou7,DC=dom6,DC=ex4' # parameter OU path to the services location
var_cleanup_temporary_folder: true # parameter clean your crap after done
var_ADGroupMember: 'ESOC-Monitoring-Servers' # parameter security group of list of servers
var_HeaderNotesSubstr: "ESOC-Monitoring-Servers" # parameter note in part of the email body

# Variables that need to be set in the Ansible Template Variables
# Get-ServiceAccountExpiration
---
var_ps_folder: 'ps_reports' # root folder of scripts
var_ps_script_file: 'cvs_report_script.ps1' # script to be execute
var_parameter_action: 'Get-ServiceAccountExpiration' # parameter -Action
var_eMailReport: 'no' # parameter email configuration
var_SMTPServer: 'dom1.dom2.dom3.example' # parameter email configuration
var_MailToString: "user4@dom3.example,user4@dom3.example" # parameter email configuration 
var_MailCcString: "user4@dom3.example,user4@dom3.example" # parameter email configuration
var_MailSubjectstring: 'Ansible-Report: ESOC Service Account Expiration Report' # parameter email configuration
var_OUPath: 'OU=ou4,OU=ou5,OU=ou7,DC=dom6,DC=ex4' # parameter OU path to the services location
var_cleanup_temporary_folder: true # parameter clean your crap after done
#var_ADGroupMember: 'ESOC-Monitoring-Servers' # parameter security group of list of servers
var_HeaderNotesSubstr: "ESOC-Monitoring-Servers" # parameter note in part of the email body