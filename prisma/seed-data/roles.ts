// The job roles the dev seed creates. Drafts with no cards or questions: admins draft those with AI
// in the admin UI and approve the role. Slugs follow roles.service `slugify(title)`.

export type SeedRole = {
  slug: string;
  title: string;
  blurb: string;
  seniority: 'entry' | 'junior' | 'mid' | 'senior';
  description: { text: string; bullets: string[] };
  keySkills: string[];
};

export const SEED_ROLES: SeedRole[] = [
  {
    slug: 'servicenow-sales-order-management',
    title: 'ServiceNow Sales & Order Management',
    blurb: 'Configure ServiceNow to run quoting, ordering and fulfilment.',
    seniority: 'mid',
    description: {
      text: 'Builds and supports the ServiceNow Sales and Order Management applications, from product catalogue and quotes through order capture, decomposition and fulfilment.',
      bullets: [
        'Configure the product catalogue, offers and pricing',
        'Set up order capture, decomposition and fulfilment flows',
        'Integrate orders with CRM, billing and inventory systems',
        'Work with sales and operations teams on requirements',
      ],
    },
    keySkills: [
      'Sales and Order Management',
      'Product catalogue',
      'Order decomposition',
      'Flow Designer',
      'Integrations',
    ],
  },
  {
    slug: 'servicenow-itsm-platform-developer',
    title: 'ServiceNow ITSM / Platform Developer',
    blurb: 'Build and extend ITSM processes on the ServiceNow platform.',
    seniority: 'mid',
    description: {
      text: 'Develops on the ServiceNow platform to deliver and improve ITSM processes such as incident, problem, change and request management.',
      bullets: [
        'Build business rules, client scripts and UI policies',
        'Automate workflows with Flow Designer and IntegrationHub',
        'Configure incident, problem, change and request processes',
        'Follow upgrade-safe development practices',
      ],
    },
    keySkills: [
      'ITSM processes',
      'JavaScript (Glide API)',
      'Business rules and client scripts',
      'Flow Designer',
      'REST integrations',
    ],
  },
  {
    slug: 'servicenow-custom-apps-developer',
    title: 'ServiceNow Custom Apps Developer',
    blurb: 'Design and build scoped custom applications on ServiceNow.',
    seniority: 'mid',
    description: {
      text: 'Designs and builds scoped custom applications on the ServiceNow platform, from data model and security through user interface and integrations.',
      bullets: [
        'Design tables, relationships and access controls for new apps',
        'Build user experiences with UI Builder and Service Portal',
        'Write server-side and client-side logic in scoped apps',
        'Ship apps through update sets or source control',
      ],
    },
    keySkills: [
      'Scoped applications',
      'Data modelling',
      'Access control (ACLs)',
      'UI Builder and Service Portal',
      'JavaScript (Glide API)',
    ],
  },
  {
    slug: 'servicenow-itsm-cmdb-administrator',
    title: 'ServiceNow ITSM / CMDB Administrator',
    blurb: 'Administer ITSM and keep the CMDB accurate and healthy.',
    seniority: 'mid',
    description: {
      text: 'Administers the ServiceNow ITSM modules and the Configuration Management Database, keeping configuration data complete, accurate and useful.',
      bullets: [
        'Administer users, groups, roles and ITSM configuration',
        'Maintain CMDB classes, relationships and data quality',
        'Run discovery and identification and reconciliation rules',
        'Monitor CMDB health and fix duplicates and stale records',
      ],
    },
    keySkills: [
      'CMDB and CSDM',
      'Discovery',
      'Identification and reconciliation',
      'ITSM administration',
      'Data quality',
    ],
  },
];
