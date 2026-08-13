vsphere-stig-config/
├── README.md
├── config/
│   └── production_stig_config.yml         # Production STIG configuration
├── roles/
│   ├── vsphere_stig_discovery/
│   │   ├── tasks/
│   │   │   └── main.yml
│   │   └── meta/
│   │       └── main.yml
│   ├── vsphere_stig_security/
│   │   ├── tasks/
│   │   │   └── main.yml
│   │   └── meta/
│   │       └── main.yml
│   ├── vsphere_stig_logging/
│   │   ├── tasks/
│   │   │   └── main.yml
│   │   └── meta/
│   │       └── main.yml
│   ├── vsphere_stig_services/
│   │   ├── tasks/
│   │   │   └── main.yml
│   │   └── meta/
│   │       └: main.yml
│   ├── vsphere_stig_lockdown/
│   │   ├── tasks/
│   │   │   └── main.yml
│   │   └── meta/
│   │       └── main.yml
│   └── vsphere_stig_reporting/
│       ├── tasks/
│       │   └── main.yml
│       └── meta/
│           └── main.yml
├── docs/
│   ├── PRODUCTION_STIG_CONTROLS.md
│   └── DEPLOYMENT_GUIDE.md
└── .gitlab-ci.yml