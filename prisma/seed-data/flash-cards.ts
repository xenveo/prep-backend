// Default flash cards and interview questions for the ServiceNow roles, from "Flash cards.pdf"
// (10 entry-level cards per role, plus generic fundamentals and HR/behavioural decks shared by every
// role). The card front, short answer and keywords are the PDF's; the spoken interview question,
// tip, common mistakes and red flags were written to match them.

export type SeedCard = {
  category: 'behavioural' | 'situational' | 'role_knowledge' | 'motivation';
  /** Card front. */
  question: string;
  /** The same question as the interviewer asks it out loud. */
  interviewQuestion: string;
  /** Card back: the short answer. */
  answer: string;
  /** What the candidate should say out loud; also the rubric's key points. */
  keywords: string[];
  tip: string;
  mistakes: string[];
  redFlags: string[];
  structure: 'star' | 'problem_solution' | 'free';
  difficulty: 'easy' | 'medium' | 'hard';
};

/** Generic: ServiceNow fundamentals (any role). */
export const FUNDAMENTALS_CARDS: SeedCard[] = [
  {
    category: 'role_knowledge',
    question: 'What is ServiceNow?',
    interviewQuestion: 'In your own words, what is ServiceNow?',
    answer:
      'A cloud-based platform for automating digital workflows. ITSM is its core product, alongside HR, CSM, ITOM and custom apps, all on one data model.',
    keywords: [
      'Cloud',
      'SaaS',
      'Workflow automation',
      'Single data model',
      'Now Platform',
    ],
    tip: 'Lead with "workflow automation on one platform", then name two or three products.',
    mistakes: [
      'Calling it only a ticketing tool',
      'Listing products without saying what ties them together',
    ],
    redFlags: ['Describes ServiceNow as only an IT helpdesk tool'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'role_knowledge',
    question: 'What is an instance?',
    interviewQuestion: 'What is a ServiceNow instance?',
    answer:
      "Your company's own copy of ServiceNow, with its own URL and database. Most companies have dev, test and production instances.",
    keywords: ['Dev/test/prod', 'URL', 'Sub-production', 'Clone'],
    tip: 'Mention the dev, test and production chain and how changes move along it.',
    mistakes: [
      'Confusing an instance with a user account or licence',
      'Forgetting sub-production instances exist',
    ],
    redFlags: ['Suggests making changes directly in production'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'role_knowledge',
    question: 'What is an update set?',
    interviewQuestion:
      'What is an update set, and how do you move one between instances?',
    answer:
      'A container that records configuration changes in one instance so you can move them to another. You complete it, retrieve it, preview it, then commit.',
    keywords: [
      'Capture changes',
      'Retrieve',
      'Preview',
      'Commit',
      'Collisions',
    ],
    tip: 'Say the four steps in order: complete, retrieve, preview, commit.',
    mistakes: [
      'Thinking update sets capture data records by default',
      'Skipping the preview step and its collisions',
    ],
    redFlags: ['Commits without previewing or resolving collisions'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'role_knowledge',
    question: 'What is the Task table?',
    interviewQuestion: 'What is the Task table, and why does it matter?',
    answer:
      'A base table that Incident, Problem, Change and Request extend. They share fields like number, state, assignment group and short description.',
    keywords: ['Parent table', 'Extends', 'Inheritance', 'Shared fields'],
    tip: 'Name two tables that extend Task and one field they inherit from it.',
    mistakes: [
      'Treating Task as a table of to-do items',
      'Not knowing which tables extend it',
    ],
    redFlags: ['Cannot name any table that extends Task'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'role_knowledge',
    question: 'What is a reference field?',
    interviewQuestion: 'What is a reference field in ServiceNow?',
    answer:
      'A field that points to a record on another table, such as caller_id pointing to sys_user. It stores the sys_id.',
    keywords: ['sys_id', 'Foreign key', 'Dot-walking'],
    tip: 'Use caller_id pointing to sys_user as your example.',
    mistakes: [
      'Saying it stores the display value instead of the sys_id',
      'Confusing it with a choice field',
    ],
    redFlags: ['Says a reference field stores the display name'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'role_knowledge',
    question: 'What is a sys_id?',
    interviewQuestion: 'What is a sys_id, and how is it used?',
    answer:
      'A unique 32-character ID that every record has. Scripts use it to find a record reliably.',
    keywords: ['Unique ID', '32-char GUID', 'Primary key'],
    tip: 'Say "32-character unique ID" and why scripts prefer it to names or numbers.',
    mistakes: [
      'Confusing the sys_id with the record number like INC0010001',
      'Hard-coding sys_ids without explaining the risk',
    ],
    redFlags: ['Confuses the sys_id with the record number'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'role_knowledge',
    question: 'What is dot-walking?',
    interviewQuestion: 'What is dot-walking, and where can you use it?',
    answer:
      'Reaching fields on referenced records using dots, such as caller_id.department.name. It works in scripts, lists, conditions and reports.',
    keywords: ['Reference chain', 'Related fields', 'No extra query'],
    tip: 'Give a chained example like caller_id.department.name.',
    mistakes: [
      'Thinking it only works in scripts',
      'Not linking it to reference fields',
    ],
    redFlags: ['Cannot give a dot-walking example'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'role_knowledge',
    question: 'Roles vs groups vs users?',
    interviewQuestion:
      "What's the difference between roles, groups and users in ServiceNow?",
    answer:
      'Users are people. Groups are teams that get work assigned. Roles grant permissions. Best practice is to give roles to groups, not individuals.',
    keywords: [
      'itil',
      'admin',
      'Group membership',
      'Assignment',
      'Least privilege',
    ],
    tip: 'Finish with the best practice: assign roles to groups, not individual users.',
    mistakes: [
      'Mixing up groups and roles',
      'Assigning roles directly to users as standard practice',
    ],
    redFlags: ['Recommends giving admin to users to fix access issues'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'role_knowledge',
    question: 'Client-side vs server-side scripting?',
    interviewQuestion:
      "What's the difference between client-side and server-side scripting in ServiceNow?",
    answer:
      'Client-side runs in the browser (client scripts, UI policies, g_form). Server-side runs on the instance (business rules, Script Includes, GlideRecord).',
    keywords: [
      'Browser',
      'Instance',
      'g_form',
      'GlideRecord',
      'GlideAjax bridge',
    ],
    tip: 'Name one API on each side, then GlideAjax as the bridge between them.',
    mistakes: [
      'Using GlideRecord in client scripts',
      'Not knowing where business rules run',
    ],
    redFlags: ['Says business rules run in the browser'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'role_knowledge',
    question: 'What are the ServiceNow release names?',
    interviewQuestion: 'How are ServiceNow releases named and delivered?',
    answer:
      'Releases are named alphabetically after cities, twice a year, with one supported upgrade path. Recent ones include Xanadu, Yokohama, Zurich and Australia.',
    keywords: ['Biannual', 'Alphabetical cities', 'Upgrade', 'Family release'],
    tip: 'Name the release you work on now and the next one.',
    mistakes: [
      'Not knowing the current release',
      'Thinking releases come out every month',
    ],
    redFlags: ['Cannot name any recent release'],
    structure: 'free',
    difficulty: 'easy',
  },
];

/** Generic: HR and behavioural (any role). */
export const BEHAVIOURAL_CARDS: SeedCard[] = [
  {
    category: 'motivation',
    question: 'Tell me about yourself.',
    interviewQuestion: 'Tell me about yourself.',
    answer:
      'Present, past, future in 60 seconds: your current role and modules, one past project with a result, and why this role fits next.',
    keywords: ['60 seconds', 'Current role', 'One result', 'Why this role'],
    tip: 'Keep it to 60 seconds: present, past, future.',
    mistakes: [
      'Reciting your whole CV',
      'Ending without saying why this role fits',
    ],
    redFlags: ['Runs well past two minutes with no clear point'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'behavioural',
    question: 'What were your roles and responsibilities on your last project?',
    interviewQuestion:
      'What were your roles and responsibilities on your last project?',
    answer:
      'Name the client and domain, your role, the modules you worked on, three main tasks and one measurable outcome.',
    keywords: ['Client', 'Modules', 'Three tasks', 'Outcome', 'Team size'],
    tip: 'Say "I", not "we", and end with one number.',
    mistakes: [
      'Describing what the team did, not what you did',
      'No measurable outcome',
    ],
    redFlags: ['Cannot name the modules they worked on'],
    structure: 'star',
    difficulty: 'easy',
  },
  {
    category: 'motivation',
    question: 'Why ServiceNow as a career?',
    interviewQuestion: 'Why did you choose ServiceNow as a career?',
    answer:
      "It's a fast-growing platform used by most large enterprises. You like solving process problems with both configuration and code, and the skills have strong demand.",
    keywords: [
      'Growth',
      'Enterprise demand',
      'Process + code',
      'Certifications',
    ],
    tip: 'Pair a market reason with a personal one: what you enjoy building.',
    mistakes: [
      'Only mentioning salary',
      'A generic answer that fits any technology',
    ],
    redFlags: ['Gives money as the only reason'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'motivation',
    question: 'Which certifications do you have or plan?',
    interviewQuestion:
      'Which ServiceNow certifications do you have, or plan to get?',
    answer:
      'Start with CSA (Certified System Administrator), then a CAD (Application Developer) or a CIS (Implementation Specialist) in your module, such as ITSM or CSM.',
    keywords: ['CSA', 'CAD', 'CIS-ITSM', 'CIS-CSM', 'Now Learning'],
    tip: 'Name what you hold, what is next, and a rough date for it.',
    mistakes: [
      'Listing certifications without a plan',
      'Naming certifications unrelated to the role',
    ],
    redFlags: ['Claims a certification but cannot say what it covers'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'behavioural',
    question: 'Describe a difficult issue you solved.',
    interviewQuestion: 'Describe a difficult issue you solved.',
    answer:
      'Use STAR: the situation, your task, the debugging steps you took (logs, debugger, impersonation), and the result with a number.',
    keywords: ['STAR', 'Root cause', 'Logs', 'Result'],
    tip: 'Spend most of the time on the steps you took, not the background.',
    mistakes: ['No clear root cause', 'Skipping the result'],
    redFlags: [
      'Blames others for the issue',
      'Fixes symptoms with no root cause',
    ],
    structure: 'star',
    difficulty: 'medium',
  },
  {
    category: 'situational',
    question: 'How do you handle a requirement you disagree with?',
    interviewQuestion: 'How do you handle a requirement you disagree with?',
    answer:
      'Understand the business need, suggest an out-of-the-box or lower-risk option with the trade-offs, and then go with the agreed decision and document it.',
    keywords: ['OOTB first', 'Trade-offs', 'Stakeholder', 'Document decision'],
    tip: 'Show you push back with options, then commit to the decision.',
    mistakes: [
      'Refusing to build it',
      'Building it silently without raising the risk',
    ],
    redFlags: ['Refuses to follow the agreed decision'],
    structure: 'problem_solution',
    difficulty: 'medium',
  },
  {
    category: 'role_knowledge',
    question: 'How do you deploy changes between instances?',
    interviewQuestion: 'How do you deploy changes between instances?',
    answer:
      'Use update sets or the application repository/source control, test in dev and test, get approval, then commit to production in a change window.',
    keywords: [
      'Update set',
      'Dev-test-prod',
      'Approval',
      'Change window',
      'Rollback',
    ],
    tip: 'Walk through dev, test, approval and production, and mention rollback.',
    mistakes: [
      'Skipping testing in a sub-production instance',
      'No rollback plan',
    ],
    redFlags: ['Suggests changing production directly'],
    structure: 'free',
    difficulty: 'medium',
  },
  {
    category: 'motivation',
    question: 'How do you keep your skills current?',
    interviewQuestion: 'How do you keep your ServiceNow skills current?',
    answer:
      'Read release notes for each family release, use a Personal Developer Instance (PDI), take Now Learning courses, and join the Community.',
    keywords: ['PDI', 'Release notes', 'Now Learning', 'Community'],
    tip: 'Mention one thing you learned recently from your PDI or release notes.',
    mistakes: [
      'A vague "I read online"',
      'Not knowing about Personal Developer Instances',
    ],
    redFlags: ['Gives no concrete learning habit'],
    structure: 'free',
    difficulty: 'easy',
  },
  {
    category: 'behavioural',
    question: 'How do you work in an Agile team?',
    interviewQuestion: 'How do you work in an Agile team?',
    answer:
      'Two-week sprints, stand-ups, user stories with acceptance criteria, estimation, and demos at sprint review. Mention ServiceNow Agile/SAFe if used.',
    keywords: [
      'Sprint',
      'User story',
      'Acceptance criteria',
      'Stand-up',
      'Demo',
    ],
    tip: 'Describe your part in a real sprint, not Agile theory.',
    mistakes: [
      'Reciting Agile definitions only',
      'No mention of acceptance criteria',
    ],
    redFlags: ['Cannot describe their part in a sprint'],
    structure: 'star',
    difficulty: 'easy',
  },
  {
    category: 'motivation',
    question: 'Do you have any questions for us?',
    interviewQuestion: 'Do you have any questions for us?',
    answer:
      "Always ask one or two: the team's main modules and roadmap, how releases and upgrades are handled, or what success looks like in the first 90 days.",
    keywords: ['Roadmap', 'Team', 'Upgrade cycle', 'First 90 days'],
    tip: 'Always have two questions ready; never say "no questions".',
    mistakes: [
      'Saying you have no questions',
      'Only asking about salary or leave',
    ],
    redFlags: ['Has no questions at all'],
    structure: 'free',
    difficulty: 'easy',
  },
];

/** Each role's own cards, keyed by role slug (prisma/seed-data/roles.ts). */
export const ROLE_CARDS: Record<string, SeedCard[]> = {
  'servicenow-sales-order-management': [
    {
      category: 'role_knowledge',
      question: 'What is ServiceNow Sales & Order Management?',
      interviewQuestion: 'What is ServiceNow Sales and Order Management?',
      answer:
        "It's a CSM / Industry app that runs the full quote-to-cash flow: product catalog, quoting, order capture, order orchestration and fulfillment, all on one platform.",
      keywords: [
        'Quote-to-cash',
        'CSM',
        'Product catalog',
        'Order orchestration',
      ],
      tip: 'Frame it as quote-to-cash on one platform, then list the stages.',
      mistakes: [
        'Describing it as the service catalog',
        'Leaving out fulfillment',
      ],
      redFlags: ['Confuses SOM with the ITSM service catalog'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'Walk through the order lifecycle end to end.',
      interviewQuestion: 'Walk me through the order lifecycle, end to end.',
      answer:
        'Customer order is captured, validated, decomposed into order lines and fulfillment tasks, fulfilled by teams or systems, then inventory is updated and the order is closed.',
      keywords: ['Capture', 'Validate', 'Decompose', 'Fulfill', 'Close'],
      tip: 'Say the five stages in order: capture, validate, decompose, fulfill, close.',
      mistakes: [
        'Skipping decomposition',
        'Ending at fulfillment without closure',
      ],
      redFlags: ['Stages out of order or missing decomposition'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is order decomposition?',
      interviewQuestion: 'What is order decomposition?',
      answer:
        'Breaking a commercial product offering into technical service and resource specifications, which generate the order line items and fulfillment tasks.',
      keywords: [
        'Product offering',
        'Product spec',
        'Service/resource spec',
        'Decomposition rules',
      ],
      tip: 'Move from commercial to technical: offering, then spec, then tasks.',
      mistakes: [
        'Confusing decomposition with splitting a bill',
        'Not mentioning specifications',
      ],
      redFlags: ['Cannot link decomposition to fulfillment tasks'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'Product Offering vs Product Specification?',
      interviewQuestion:
        "What's the difference between a product offering and a product specification?",
      answer:
        'An offering is what the customer buys (price, bundle, terms). A specification is the technical definition of what is delivered. One spec can sit behind many offerings.',
      keywords: ['Commercial vs technical', 'Product model', 'Characteristics'],
      tip: 'Use "commercial vs technical" and an example of one spec behind two offerings.',
      mistakes: [
        'Treating them as the same thing',
        'Reversing which one is customer-facing',
      ],
      redFlags: ['Says the specification holds the price'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is a fulfillment task?',
      interviewQuestion: 'What is a fulfillment task?',
      answer:
        'A unit of work created from decomposition, such as provisioning or shipping, assigned to a fulfillment team or an external system. The order completes when all its tasks close.',
      keywords: [
        'Order task',
        'Assignment group',
        'Dependency',
        'External system',
      ],
      tip: 'End with the rule: the order completes when all its tasks close.',
      mistakes: [
        'Forgetting tasks can go to external systems',
        'Ignoring dependencies between tasks',
      ],
      redFlags: ['Cannot say where fulfillment tasks come from'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'situational',
      question: 'An order is stuck. Where do you look first?',
      interviewQuestion:
        'An order is stuck and not progressing. Where do you look first?',
      answer:
        "Open the order's lines and tasks, filter for open ones, then check the blocking task's assignee, work notes, flow context and integration logs.",
      keywords: [
        'Order tasks',
        'Open state',
        'Flow execution',
        'Integration log',
        'Escalate',
      ],
      tip: 'Give an order of checks: tasks first, then the flow, then integrations.',
      mistakes: [
        'Restarting the order without diagnosis',
        'Not checking the flow context',
      ],
      redFlags: ['Cancels or recreates the order before finding the cause'],
      structure: 'problem_solution',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'How are SLAs applied to orders?',
      interviewQuestion: 'How are SLAs applied to orders?',
      answer:
        'SLA definitions on the order or task table start, pause and stop on conditions. Task SLA records track time left and fire notifications at 50/75/100%.',
      keywords: ['Task SLA', 'Start/pause/stop', 'Breach', 'Notifications'],
      tip: 'Mention start, pause and stop conditions and the 50/75/100% alerts.',
      mistakes: [
        'Thinking SLAs are only for incidents',
        'Forgetting pause conditions',
      ],
      redFlags: ['Cannot explain how an SLA starts or stops'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'situational',
      question: 'How do you prioritize orders close to breach?',
      interviewQuestion:
        'How do you prioritize orders that are close to breaching their SLA?',
      answer:
        'Sort by SLA time left and percentage elapsed, then weigh customer tier, order value and blocking dependencies. Escalate the at-risk ones.',
      keywords: [
        'SLA % elapsed',
        'Business impact',
        'Customer tier',
        'Dashboard',
      ],
      tip: 'Combine SLA time left with business impact, not time alone.',
      mistakes: [
        'First come, first served',
        'Ignoring customer tier and value',
      ],
      redFlags: ['Works orders only in arrival order'],
      structure: 'problem_solution',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is a change order (order amendment)?',
      interviewQuestion: 'What is a change order, or order amendment?',
      answer:
        'A request to modify or cancel an in-flight order. The system compares the changes, then adjusts or cancels the affected lines and tasks.',
      keywords: ['Amend', 'Cancel', 'In-flight order', 'Revision'],
      tip: 'Stress "in-flight": the order is already being fulfilled.',
      mistakes: [
        'Confusing it with an ITSM change request',
        'Saying the whole order is recreated',
      ],
      redFlags: ['Confuses an order amendment with an ITSM change request'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'How do orders enter SOM from outside?',
      interviewQuestion:
        'How do orders enter Sales and Order Management from outside systems?',
      answer:
        'Through the TM Forum Open APIs (such as Product Order API), REST integrations from CRM or CPQ tools, or the agent workspace and portal.',
      keywords: ['TM Forum Open API', 'REST', 'CPQ/CRM', 'Workspace'],
      tip: 'Name the TM Forum Product Order API and one manual channel.',
      mistakes: [
        'Only mentioning manual entry',
        'Not knowing the TM Forum APIs',
      ],
      redFlags: ['Cannot name any integration channel'],
      structure: 'free',
      difficulty: 'medium',
    },
  ],

  'servicenow-itsm-platform-developer': [
    {
      category: 'role_knowledge',
      question: 'What is a business rule?',
      interviewQuestion: 'What is a business rule?',
      answer:
        'Server-side script that runs when a record is displayed, inserted, updated, deleted or queried. Types are before, after, async and display.',
      keywords: ['Server-side', 'When to run', 'Condition', 'current/previous'],
      tip: 'Name the four types: before, after, async, display.',
      mistakes: [
        'Saying business rules run in the browser',
        'Missing the async type',
      ],
      redFlags: ['Says business rules are client-side'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'Before vs after business rule?',
      interviewQuestion:
        "What's the difference between a before and an after business rule?",
      answer:
        'Before runs prior to the database save and changes the current record without update(). After runs post-save and is used to update related records.',
      keywords: [
        'Pre-save',
        'Post-save',
        'No current.update()',
        'Related records',
      ],
      tip: 'Mention never calling current.update() in a before rule.',
      mistakes: [
        'Calling current.update() in a before rule',
        'Using after rules to change the current record',
      ],
      redFlags: ['Recommends current.update() inside a business rule'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'After vs async business rule?',
      interviewQuestion:
        "What's the difference between an after and an async business rule?",
      answer:
        'After is synchronous in the same transaction, so the user waits. Async is queued as a background job, which is faster for the user but runs later.',
      keywords: [
        'Same transaction',
        'Scheduled job',
        'Performance',
        'No user message',
      ],
      tip: 'Tie the choice to user wait time and integrations.',
      mistakes: [
        'Thinking async rules can show messages to the user',
        'Using after rules for slow integrations',
      ],
      redFlags: ['Cannot say when async is the better choice'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is a display business rule used for?',
      interviewQuestion: 'What is a display business rule used for?',
      answer:
        'Runs when the form loads and passes server data to client scripts through g_scratchpad. This avoids extra server calls.',
      keywords: ['g_scratchpad', 'Form load', 'Client access'],
      tip: 'Say g_scratchpad and why it saves a server call.',
      mistakes: [
        'Using it to change data on save',
        'Not knowing about g_scratchpad',
      ],
      redFlags: ['Cannot explain g_scratchpad'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is an ACL?',
      interviewQuestion: 'What is an ACL, and how is it evaluated?',
      answer:
        'Access Control rule that decides who can read, write, create or delete a table or field, using roles, conditions and scripts. Table rules are checked before field rules.',
      keywords: [
        'Access control',
        'Role',
        'Condition',
        'Script',
        'table.field',
        'Security Debugger',
      ],
      tip: 'Mention table rules checked before field rules, and the Security Debugger.',
      mistakes: [
        'Thinking UI policies secure data',
        'Ignoring table versus field order',
      ],
      redFlags: ['Says hiding a field on the form secures it'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is Flow Designer?',
      interviewQuestion: 'What is Flow Designer?',
      answer:
        'Low-code automation tool with triggers, conditions, actions and subflows. It replaces most legacy workflows and scripted automation.',
      keywords: ['Trigger', 'Action', 'Subflow', 'Data pill', 'Low-code'],
      tip: 'Name the building blocks: trigger, actions, subflows, data pills.',
      mistakes: [
        'Saying legacy workflow is still the default choice',
        'Not knowing subflows',
      ],
      redFlags: ['Cannot name the parts of a flow'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'What triggers can a flow have?',
      interviewQuestion: 'What kinds of triggers can a flow have?',
      answer:
        'Record triggers (created or updated), scheduled triggers (daily, weekly, once) and application triggers (inbound email, service catalog, SLA).',
      keywords: ['Record', 'Scheduled', 'Application', 'Service catalog'],
      tip: 'Group them into three: record, scheduled, application.',
      mistakes: [
        'Only mentioning record triggers',
        'Forgetting service catalog triggers',
      ],
      redFlags: ['Names only one kind of trigger'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'What is a custom action?',
      interviewQuestion: 'What is a custom action in Flow Designer?',
      answer:
        'A reusable Flow Designer step with defined inputs, steps and outputs, built once and used in many flows. You can package them in a spoke.',
      keywords: ['Inputs', 'Outputs', 'Script step', 'Reusable', 'Spoke'],
      tip: 'Stress reuse: inputs and outputs, built once, packaged in a spoke.',
      mistakes: [
        'Confusing actions with subflows',
        'Not mentioning inputs and outputs',
      ],
      redFlags: ['Cannot say why you would build a custom action'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'Synchronous vs asynchronous?',
      interviewQuestion:
        "What's the difference between synchronous and asynchronous calls in ServiceNow?",
      answer:
        'Sync waits for the result before continuing, while async continues and handles the result later. Example: GlideAjax getXMLAnswer is async, getXMLWait is sync.',
      keywords: ['Blocking', 'Callback', 'getXMLAnswer', 'Background'],
      tip: 'Use the GlideAjax example: getXMLAnswer versus getXMLWait.',
      mistakes: [
        'Recommending synchronous calls on the client',
        'Not knowing what a callback is',
      ],
      redFlags: ['Recommends getXMLWait as the normal choice'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is OAuth 2.0 in ServiceNow?',
      interviewQuestion: 'How is OAuth 2.0 used in ServiceNow integrations?',
      answer:
        'A token-based authentication method for integrations. You configure an Application Registry entry and an OAuth profile, and the access token replaces a password.',
      keywords: [
        'Access token',
        'Refresh token',
        'Client ID/secret',
        'Application Registry',
        'Grant type',
      ],
      tip: 'Mention the Application Registry and why tokens beat stored passwords.',
      mistakes: [
        'Confusing OAuth with basic authentication',
        'Not knowing about refresh tokens',
      ],
      redFlags: ['Suggests sharing a user password for integrations'],
      structure: 'free',
      difficulty: 'hard',
    },
  ],

  'servicenow-custom-apps-developer': [
    {
      category: 'role_knowledge',
      question: 'What is a scoped application?',
      interviewQuestion: 'What is a scoped application?',
      answer:
        'An app built in its own namespace (x_vendor_app), so its tables, scripts and permissions are isolated from global and other apps.',
      keywords: [
        'Scope',
        'Namespace',
        'Isolation',
        'App Engine Studio',
        'Cross-scope',
      ],
      tip: 'Mention the x_ namespace prefix and cross-scope access.',
      mistakes: [
        'Building new apps in global by default',
        'Not knowing about cross-scope privileges',
      ],
      redFlags: ['Says scope has no effect on access'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'What is a Script Include?',
      interviewQuestion: 'What is a Script Include?',
      answer:
        'A reusable server-side class or function library, called from business rules, flows or the client through GlideAjax.',
      keywords: ['Reusable', 'Server-side', 'Class', 'Client callable'],
      tip: 'Say where you call one from: business rules, flows and GlideAjax.',
      mistakes: [
        'Thinking Script Includes run in the browser',
        'Forgetting the client callable flag',
      ],
      redFlags: ['Duplicates the same code across business rules instead'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'What is GlideAjax?',
      interviewQuestion: 'What is GlideAjax, and when do you use it?',
      answer:
        'It lets a client script call a client-callable Script Include asynchronously and return only the data it needs.',
      keywords: [
        'AbstractAjaxProcessor',
        'sysparm_name',
        'getXMLAnswer',
        'Callback',
      ],
      tip: 'Walk the chain: client script, GlideAjax, Script Include, callback.',
      mistakes: [
        'Using GlideRecord in a client script instead',
        'Using getXMLWait by default',
      ],
      redFlags: ['Suggests GlideRecord in client scripts'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is GlideRecord?',
      interviewQuestion: 'What is GlideRecord?',
      answer:
        'The server-side API to query, insert, update and delete records in a table.',
      keywords: ['addQuery', 'query()', 'next()', 'insert()', 'update()'],
      tip: 'Say the basic pattern out loud: addQuery, query, while next.',
      mistakes: [
        'Forgetting to call query() before next()',
        'Running GlideRecord in client scripts',
      ],
      redFlags: ['Cannot describe a basic GlideRecord query'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'Client script types?',
      interviewQuestion: 'What types of client scripts are there?',
      answer:
        'onLoad, onChange, onSubmit and onCellEdit. They run in the browser and use g_form and g_user.',
      keywords: ['onLoad', 'onChange', 'onSubmit', 'onCellEdit', 'g_form'],
      tip: 'Name all four and give one use for onChange.',
      mistakes: [
        'Forgetting onCellEdit',
        'Thinking client scripts run on the server',
      ],
      redFlags: ['Cannot name the client script types'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'UI policy vs client script?',
      interviewQuestion:
        'When do you use a UI policy instead of a client script?',
      answer:
        "UI policies make fields mandatory, read-only or visible without code. Client scripts are for logic that a UI policy can't express. Prefer UI policies.",
      keywords: [
        'No-code',
        'Mandatory/visible/read-only',
        'Conditions',
        'Best practice',
      ],
      tip: 'State the best practice: UI policy first, client script only when needed.',
      mistakes: [
        'Writing client scripts for simple mandatory fields',
        'Thinking UI policies secure data',
      ],
      redFlags: ['Prefers code for everything a UI policy can do'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'What is a transform map?',
      interviewQuestion: 'What is a transform map?',
      answer:
        'It maps fields from an import set staging table to a target table. Coalesce fields stop duplicates by updating existing records.',
      keywords: ['Import set', 'Field map', 'Coalesce', 'Transform script'],
      tip: 'Explain coalesce: match an existing record and update it instead of inserting.',
      mistakes: [
        'Not knowing what coalesce does',
        'Loading straight into the target table',
      ],
      redFlags: ['Cannot explain how duplicates are prevented on import'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'situational',
      question: 'How do you avoid duplicate incidents?',
      interviewQuestion:
        'Incidents from an external system are arriving as duplicates. How do you prevent that?',
      answer:
        'Store the external ID in a correlation field, coalesce on it during import, and check for an open match in a before-insert business rule.',
      keywords: ['correlation_id', 'Coalesce', 'Before BR', 'setAbortAction'],
      tip: 'Mention correlation_id, then a before-insert check as the safety net.',
      mistakes: [
        'Deleting duplicates afterwards instead of preventing them',
        'Matching on short description',
      ],
      redFlags: ['Proposes cleaning duplicates manually as the fix'],
      structure: 'problem_solution',
      difficulty: 'medium',
    },
    {
      category: 'situational',
      question: 'How do you avoid duplicate CIs?',
      interviewQuestion:
        'How do you stop duplicate configuration items being created when loading CI data?',
      answer:
        'Load CIs through IRE (Identification and Reconciliation Engine), which matches them on identification rules like serial number before inserting.',
      keywords: [
        'IRE',
        'Identification rule',
        'Reconciliation',
        'CMDBTransformUtil',
      ],
      tip: 'Say IRE, and that it matches on rules such as serial number before inserting.',
      mistakes: [
        'Inserting CIs directly with GlideRecord',
        'Matching on CI name only',
      ],
      redFlags: ['Bypasses IRE when loading CIs'],
      structure: 'problem_solution',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is a catalog item vs a record producer?',
      interviewQuestion:
        "What's the difference between a catalog item and a record producer?",
      answer:
        'A catalog item creates a request (REQ, RITM, tasks). A record producer uses a catalog form to create a record on another table, such as an Incident.',
      keywords: [
        'Variables',
        'RITM',
        'Record producer',
        'Target table',
        'Flow',
      ],
      tip: 'Contrast what each creates: a REQ and RITM versus a record on a target table.',
      mistakes: [
        'Thinking a record producer creates an RITM',
        'Not mentioning variables',
      ],
      redFlags: ['Cannot say what a record producer creates'],
      structure: 'free',
      difficulty: 'medium',
    },
  ],

  'servicenow-itsm-cmdb-administrator': [
    {
      category: 'role_knowledge',
      question: 'Incident vs Problem vs Change?',
      interviewQuestion:
        "What's the difference between an incident, a problem and a change?",
      answer:
        'An incident restores service fast, a problem finds and removes the root cause, and a change makes a controlled, approved modification.',
      keywords: ['Restore', 'Root cause', 'Planned fix', 'Known error', 'CAB'],
      tip: 'One verb each: restore, find the root cause, modify safely.',
      mistakes: [
        'Treating problem and incident as the same',
        'Forgetting change approval',
      ],
      redFlags: ['Says incidents should wait for the root cause'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'What are the incident states?',
      interviewQuestion: 'What are the incident states?',
      answer:
        'New, In Progress, On Hold, Resolved, Closed (or Canceled). A resolved incident auto-closes after a set number of days.',
      keywords: ['Lifecycle', 'Resolve', 'Close code', 'Auto-close'],
      tip: 'List the states in order and mention auto-close after resolution.',
      mistakes: ['Confusing Resolved with Closed', 'Forgetting On Hold'],
      redFlags: ['Cannot list the incident states'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'How is priority calculated?',
      interviewQuestion: 'How is incident priority calculated?',
      answer:
        'Priority comes from Impact × Urgency through the priority data lookup table. Users set impact and urgency, not priority directly.',
      keywords: ['Impact', 'Urgency', 'Data lookup', 'Priority matrix'],
      tip: 'Say "impact times urgency" and the data lookup table.',
      mistakes: [
        'Saying users choose priority directly',
        'Mixing up impact and urgency',
      ],
      redFlags: ['Says priority is set by hand'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'role_knowledge',
      question: 'How do you define an SLA?',
      interviewQuestion: 'How do you define an SLA in ServiceNow?',
      answer:
        'Create an SLA Definition with the table, duration, schedule and start, pause and stop conditions. A Task SLA record then tracks each ticket.',
      keywords: ['SLA Definition', 'Schedule', 'Start/pause/stop', 'Task SLA'],
      tip: 'List the parts of the definition, then say Task SLA tracks each ticket.',
      mistakes: ['Forgetting the schedule', 'Not mentioning pause conditions'],
      redFlags: ['Cannot describe what an SLA definition contains'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'situational',
      question: "An SLA isn't attaching. What do you check?",
      interviewQuestion:
        "An SLA isn't attaching to a ticket. What do you check?",
      answer:
        'Check that the definition is active, the start condition matches the record, and the schedule is valid. Then look for cancelled Task SLAs and logs.',
      keywords: [
        'Active',
        'Start condition',
        'Schedule',
        'Task SLA',
        'Repair SLA',
      ],
      tip: 'Check in order: active, start condition, schedule, then logs.',
      mistakes: [
        'Recreating the SLA definition straight away',
        'Not checking the start condition against the record',
      ],
      redFlags: ['Edits the definition before diagnosing'],
      structure: 'problem_solution',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'SLA vs OLA vs UC?',
      interviewQuestion:
        "What's the difference between an SLA, an OLA and an underpinning contract?",
      answer:
        'An SLA is with the customer, an OLA is between internal teams, and an Underpinning Contract (UC) is with an external vendor.',
      keywords: ['Customer', 'Internal team', 'Vendor', 'Agreement'],
      tip: 'One word each: customer, internal team, vendor.',
      mistakes: [
        'Mixing up OLA and UC',
        'Thinking all three are with customers',
      ],
      redFlags: ['Swaps OLA and UC'],
      structure: 'free',
      difficulty: 'easy',
    },
    {
      category: 'situational',
      question: 'Wrong assignment group on incidents. How do you fix it?',
      interviewQuestion:
        'Incidents are going to the wrong assignment group. How do you fix it?',
      answer:
        "Check the assignment rules, data lookups and any business rule or flow setting the group. Correct the rule's conditions and order, then reassign the existing tickets.",
      keywords: [
        'Assignment rules',
        'Audit history',
        'Order',
        'Predictive Intelligence',
      ],
      tip: 'Find what set the group, using audit history, before changing any rule.',
      mistakes: ['Only reassigning tickets by hand', 'Not checking rule order'],
      redFlags: ['Fixes the tickets but not the rule'],
      structure: 'problem_solution',
      difficulty: 'medium',
    },
    {
      category: 'situational',
      question: "A user can't see work notes. Why?",
      interviewQuestion:
        "A user can't see work notes on an incident. Why might that be?",
      answer:
        'Work notes need the itil role (or similar) through ACLs. Impersonate the user, then check their roles, the field ACL, the form layout and UI policies.',
      keywords: [
        'itil role',
        'ACL',
        'Impersonate',
        'Security Debugger',
        'Additional comments',
      ],
      tip: 'Start by impersonating the user, then check roles and the field ACL.',
      mistakes: [
        'Granting admin to fix it',
        'Confusing work notes with additional comments',
      ],
      redFlags: ['Grants the admin role to fix visibility'],
      structure: 'problem_solution',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'What is the CMDB and what is IRE?',
      interviewQuestion: 'What is the CMDB, and what is IRE?',
      answer:
        'The CMDB stores configuration items and their relationships. IRE is the engine that identifies and reconciles incoming CI data to stop duplicates.',
      keywords: [
        'CI',
        'Relationships',
        'Identification rules',
        'Reconciliation',
        'Data source precedence',
      ],
      tip: 'Mention relationships, not just CIs, and IRE stopping duplicates.',
      mistakes: [
        'Describing the CMDB as an asset list',
        'Not knowing what IRE does',
      ],
      redFlags: ['Says CIs should be inserted directly, bypassing IRE'],
      structure: 'free',
      difficulty: 'medium',
    },
    {
      category: 'role_knowledge',
      question: 'Client script vs catalog client script?',
      interviewQuestion:
        "What's the difference between a client script and a catalog client script?",
      answer:
        'A client script runs on a table form like Incident. A catalog client script runs on a catalog item or variable set and works with variables.',
      keywords: [
        'Table form',
        'Catalog item',
        'Variables',
        'Applies on RITM/task',
      ],
      tip: 'Contrast where each runs: a table form versus a catalog item or variable set.',
      mistakes: [
        'Thinking they are interchangeable',
        'Forgetting variable sets',
      ],
      redFlags: ['Cannot say where a catalog client script runs'],
      structure: 'free',
      difficulty: 'medium',
    },
  ],
};
